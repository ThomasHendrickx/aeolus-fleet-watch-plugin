import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createShipWakeups } from './ship-wakeups.js';

/** A network stream whose bytes arrive before its response closes. */
function aStream() {
  let writer: ReadableStreamDefaultController<Uint8Array> | undefined;
  let isCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { writer = controller; },
    cancel() { isCancelled = true; },
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    write(text: string) { if (!isCancelled) { writer?.enqueue(new TextEncoder().encode(text)); } },
    close() { writer?.close(); },
  };
}

function aWatch(options: { answers?: (Response | Error | Promise<Response>)[]; look?: () => Promise<void>; random?: () => number } = {}) {
  const streams = [aStream(), aStream(), aStream()];
  const answers = [...(options.answers ?? [])];
  const signals: (AbortSignal | null | undefined)[] = [];
  let openings = 0;
  let looks = 0;
  let endings = 0;
  const failures: unknown[] = [];
  const stop = createShipWakeups({
    fleetUrl: 'https://fleet.example',
    fetch: (input, init) => {
      expect(input).toBe('https://fleet.example/api/v1/ship/wakeups');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-crew');
      expect(new Headers(init?.headers).get('accept')).toBe('text/event-stream');
      signals.push(init?.signal);
      const answer = answers.shift() ?? streams[Math.min(openings, 2)]?.response ?? new Response(null, { status: 503 });
      openings += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    random: options.random ?? (() => 0),
    look: () => { looks += 1; return options.look?.() ?? Promise.resolve(); },
    ended: () => { endings += 1; return Promise.resolve(); },
    failed: (error) => { failures.push(error); },
  })('test-crew');
  stops.push(stop);
  return { streams, signals, stop, failures, openings: () => openings, looks: () => looks, endings: () => endings };
}

const stops: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { stops.splice(0).forEach((stop) => stop()); vi.restoreAllMocks(); vi.useRealTimers(); });
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Keep the same stream alive while testing the independent safety deadline. */
async function keepAliveFor(stream: ReturnType<typeof aStream> | undefined, milliseconds: number) {
  for (let left = milliseconds; left > 0; left -= 25_000) {
    stream?.write(': keep-alive\n\n');
    await vi.advanceTimersByTimeAsync(Math.min(left, 25_000));
  }
}

describe('the watch ship wake stream', () => {
  it('receives on a fragmented open wake before the stream closes', async () => {
    const watch = aWatch();
    await flush();

    watch.streams[0]?.write('event: wa');
    watch.streams[0]?.write('ke\r\ndata: {"reason":"open"}\r\n\r\n');
    await flush();

    expect(watch.looks()).toBe(1);
  });

  it('receives on every subsequent wake', async () => {
    const watch = aWatch();
    await flush();
    watch.streams[0]?.write('event: wake\n\n');
    await flush();

    watch.streams[0]?.write('event: wake\ndata: {"reason":"notice"}\n\n');
    await flush();

    expect(watch.looks()).toBe(2);
  });

  it('one more look on a wake during a look', async () => {
    const held = Promise.withResolvers<void>();
    const watch = aWatch({ look: () => held.promise });
    await flush();
    watch.streams[0]?.write('event: wake\n\n');
    await flush();

    watch.streams[0]?.write('event: wake\n\nevent: wake\n\n');
    await flush();
    held.resolve();
    await flush();

    expect(watch.looks()).toBe(2);
  });

  it('looks serialized while the first receive waits', async () => {
    const held = Promise.withResolvers<void>();
    let active = 0;
    let maximum = 0;
    const watch = aWatch({ look: async () => { active += 1; maximum = Math.max(maximum, active); await held.promise; active -= 1; } });
    await flush();

    watch.streams[0]?.write('event: wake\n\nevent: wake\n\n');
    await flush();
    held.resolve();
    await flush();

    expect(maximum).toBe(1);
  });

  it('receives every five minutes when wakes are lost', async () => {
    const watch = aWatch();
    await flush();

    await keepAliveFor(watch.streams[0], 299_999);
    expect(watch.looks()).toBe(0);
    await keepAliveFor(watch.streams[0], 1);

    expect(watch.looks()).toBe(1);
  });

  it('a wake resets the safety timer', async () => {
    const watch = aWatch();
    await flush();
    await keepAliveFor(watch.streams[0], 100_000);

    watch.streams[0]?.write('event: wake\n\n');
    await flush();
    await keepAliveFor(watch.streams[0], 299_999);
    expect(watch.looks()).toBe(1);
    await keepAliveFor(watch.streams[0], 1);

    expect(watch.looks()).toBe(2);
  });

  it.each([
    { reason: 'a network error', answer: new Error('network down') },
    { reason: 'a non-LEASE_ENDED 401', answer: Response.json({ code: 'UNAUTHORIZED', message: 'try again' }, { status: 401 }) },
    { reason: 'FLEET_BUSY', answer: Response.json({ code: 'FLEET_BUSY', message: 'busy' }, { status: 503 }) },
    { reason: 'another refused opening', answer: new Response(null, { status: 403 }) },
  ])('reopen after $reason uses the random spread', async ({ answer }) => {
    const watch = aWatch({ answers: [answer], random: () => 1 });
    await flush();

    await vi.advanceTimersByTimeAsync(4999);
    expect(watch.openings()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(watch.openings()).toBe(2);
  });

  it.each([
    { reason: 'a network error', answer: new Error('network down') },
    { reason: 'a non-LEASE_ENDED 401', answer: Response.json({ code: 'UNAUTHORIZED', message: 'try again' }, { status: 401 }) },
  ])('receives the reopened open wake after $reason', async ({ answer }) => {
    const watch = aWatch({ answers: [answer] });
    await flush();

    await vi.advanceTimersByTimeAsync(1000);
    watch.streams[1]?.write('event: wake\ndata: {"reason":"open"}\n\n');
    await flush();

    expect(watch.looks()).toBe(1);
  });

  it('doubles failed opening delays to a sixty second cap', async () => {
    const watch = aWatch({ answers: Array.from({ length: 12 }, () => new Response(null, { status: 503 })) });
    await flush();

    for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) {
      const before = watch.openings();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(watch.openings()).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(watch.openings()).toBe(before + 1);
    }
  });

  it('a wake resets the backoff after refused openings', async () => {
    const watch = aWatch({ answers: [new Response(null, { status: 503 }), new Response(null, { status: 503 })] });
    await vi.advanceTimersByTimeAsync(3000);
    watch.streams[2]?.write('event: wake\n\n');
    await flush();

    watch.streams[2]?.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(watch.openings()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);

    expect(watch.openings()).toBe(4);
  });

  it('sixty seconds of silence reopens the stream', async () => {
    const watch = aWatch();
    await flush();

    await vi.advanceTimersByTimeAsync(60_999);
    expect(watch.openings()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(watch.openings()).toBe(2);
  });

  it('keep-alive bytes reset the silence timer', async () => {
    const watch = aWatch();
    await flush();
    await vi.advanceTimersByTimeAsync(59_999);

    watch.streams[0]?.write(': keep-alive\n\n');
    await vi.advanceTimersByTimeAsync(59_999);

    expect(watch.openings()).toBe(1);
  });

  it('a closed stream reopens after the spread', async () => {
    const watch = aWatch();
    await flush();

    watch.streams[0]?.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(watch.openings()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(watch.openings()).toBe(2);
  });

  it('stop aborts the stream', async () => {
    const watch = aWatch();
    await flush();

    watch.stop();

    expect(watch.signals[0]?.aborted).toBe(true);
  });

  it('nothing reopens after stop', async () => {
    const watch = aWatch({ answers: [new Response(null, { status: 503 })] });
    await flush();

    watch.stop();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(watch.openings()).toBe(1);
  });

  it('stop discards the extra look queued by a wake', async () => {
    const held = Promise.withResolvers<void>();
    const watch = aWatch({ look: () => held.promise });
    await flush();
    watch.streams[0]?.write('event: wake\n\nevent: wake\n\n');
    await flush();

    watch.stop();
    held.resolve();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(watch.looks()).toBe(1);
  });

  it('a queued safety callback cannot receive after stop', async () => {
    const watch = aWatch();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await flush();
    watch.streams[0]?.write('event: wake\n\n');
    await flush();
    const callback = timers.mock.calls.find((call) => call[1] === 300_000)?.[0];

    watch.stop();
    if (typeof callback !== 'function') { throw new Error('missing safety timer'); }
    callback();
    await flush();

    expect(watch.looks()).toBe(1);
  });

  it.each([
    { reason: 'opening refusal', answers: [Response.json({ code: 'LEASE_ENDED', message: 'ended' }, { status: 401 })], text: '' },
    { reason: 'end event', answers: [], text: 'event: end\ndata: {"code":"LEASE_ENDED","message":"ended"}\n\n' },
  ])('a LEASE_ENDED $reason ends the lease', async ({ answers, text }) => {
    const watch = aWatch({ answers });
    await flush();

    watch.streams[0]?.write(text);
    await flush();

    expect(watch.endings()).toBe(1);
  });

  it('a LEASE_ENDED event stops reopening', async () => {
    const watch = aWatch();
    await flush();

    watch.streams[0]?.write('event: end\ndata: {"code":"LEASE_ENDED","message":"ended"}\n\n');
    await vi.advanceTimersByTimeAsync(600_000);

    expect(watch.openings()).toBe(1);
  });

  it.each([
    { reason: 'another code mentioning LEASE_ENDED', data: { code: 'OTHER', message: 'LEASE_ENDED' } },
    { reason: 'a refusal missing its message', data: { code: 'LEASE_ENDED' } },
  ])('parses an end refusal and ignores $reason', async ({ data }) => {
    const watch = aWatch();
    await flush();

    watch.streams[0]?.write(`event: end\ndata: ${JSON.stringify(data)}\n\nevent: wake\n\n`);
    await flush();

    expect(watch.looks()).toBe(1);
  });

  it('stop ignores a late opening refusal', async () => {
    const opening = Promise.withResolvers<Response>();
    const watch = aWatch({ answers: [opening.promise] });

    watch.stop();
    opening.resolve(Response.json({ code: 'LEASE_ENDED', message: 'ended' }, { status: 401 }));
    await flush();

    expect(watch.endings()).toBe(0);
  });

  it('stop ignores a refusal whose body arrives late', async () => {
    const stream = aStream();
    const watch = aWatch({ answers: [new Response(stream.response.body, { status: 401 })] });
    await flush();

    watch.stop();
    stream.write('{"code":"LEASE_ENDED","message":"ended"}');
    stream.close();
    await flush();

    expect(watch.endings()).toBe(0);
  });

  it('stop ignores final bytes from an old reader', async () => {
    const watch = aWatch();
    await flush();

    watch.streams[0]?.write('event: end\ndata: {"code":"LEASE_ENDED","message":"ended"}\n\n');
    watch.stop();
    await flush();

    expect(watch.endings()).toBe(0);
  });

  it('an aborted opening does not report a failure', async () => {
    const opening = Promise.withResolvers<Response>();
    const watch = aWatch({ answers: [opening.promise] });

    watch.stop();
    opening.reject(new Error('aborted'));
    await flush();

    expect(watch.failures).toEqual([]);
  });
});

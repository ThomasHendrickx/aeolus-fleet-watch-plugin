import type { FleetId } from '@aeolus-fleet/common';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FLEET_ID, OTHER_FLEET_ID, SHIP_ID, memoryConnectionStore } from '../../../test/support/connection-fakes.js';
import { createDropEndedCrew } from '../../core/connection/drop-ended-crew.js';
import type { ConnectionStore } from '../../core/connection/ports.js';
import { err, ok } from '../../core/shared/result.js';
import { watchFleets, type FleetCallOnce } from './fleet-watch.js';
import { createShipWakeups } from './ship-wakeups.js';
import { refuse } from '../../core/shared/errors.js';

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); vi.useRealTimers(); });
const flush = () => vi.advanceTimersByTimeAsync(0);

async function aWatch(options: { fleets?: FleetId[]; once?: FleetCallOnce; connections?: ConnectionStore; isServed?: (fleetId: FleetId) => Promise<boolean> } = {}) {
  const connections = options.connections ?? memoryConnectionStore();
  for (const fleetId of options.fleets ?? [FLEET_ID]) {
    await connections.save({ fleetId, shipId: SHIP_ID, name: 'watch', crewToken: fleetId, crewedAt: new Date('2026-11-15') });
  }
  const streams: { token: string; signal: AbortSignal | null | undefined; writer: ReadableStreamDefaultController<Uint8Array> | undefined }[] = [];
  const received: { fleetId: FleetId; signal: AbortSignal }[] = [];
  const remaining = new Map<FleetId, number>();
  const acknowledged = new Map<FleetId, number>();
  const enabled = new Set(options.fleets ?? [FLEET_ID]);
  const server = Fastify({ logger: false });
  const watch = watchFleets({
    connections, dropEndedCrew: createDropEndedCrew({ connections }), isServed: options.isServed ?? ((fleetId) => Promise.resolve(enabled.has(fleetId))),
    log: server.log, rescanMs: 5000, doing: 'receiving',
    once: async (fleetId, until) => {
      received.push({ fleetId, signal: until.signal });
      // Model receive's existing wait without an endless immediately resolved polling loop.
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); until.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 1);
        until.signal.addEventListener('abort', done, { once: true });
        if (until.signal.aborted) { done(); }
      });
      if (options.once) { return options.once(fleetId, until); }
      const count = Math.min(remaining.get(fleetId) ?? 0, 10);
      remaining.set(fleetId, (remaining.get(fleetId) ?? 0) - count);
      acknowledged.set(fleetId, (acknowledged.get(fleetId) ?? 0) + count);
      return ok({ acknowledged: count });
    },
    start: (crewToken, events) => createShipWakeups({
      fleetUrl: 'https://fleet.example', ...events, random: () => 0, failed: () => undefined,
      fetch: (_input, init) => {
        const stream: typeof streams[number] = { token: crewToken, signal: init?.signal, writer: undefined };
        const body = new ReadableStream<Uint8Array>({ start(writer) { stream.writer = writer; } });
        streams.push(stream);
        return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
      },
    })(crewToken),
  });
  cleanups.push(async () => { await watch.stop(); await server.close(); });
  await watch.rescan();
  await flush();
  const wake = (index = 0) => { streams[index]?.writer?.enqueue(new TextEncoder().encode('event: wake\ndata: {"reason":"open"}\n\n')); };
  return { watch, connections, streams, received, remaining, acknowledged, enabled, wake };
}

describe('receiving for each served fleet', () => {
  it('holds one stream per served fleet even when rescans overlap', async () => {
    const running = await aWatch({ fleets: [FLEET_ID, OTHER_FLEET_ID] });

    await Promise.all([running.watch.rescan(), running.watch.rescan()]);

    expect(running.streams.map((stream) => stream.token)).toEqual([FLEET_ID, OTHER_FLEET_ID]);
  });

  it('receives on the open wake and waits for another hint after an empty page', async () => {
    const running = await aWatch();

    running.wake();
    await vi.advanceTimersByTimeAsync(10);

    expect(running.received).toHaveLength(1);
  });

  it('a backlog larger than one page is all received on one wake', async () => {
    const running = await aWatch();
    running.remaining.set(FLEET_ID, 21);

    running.wake();
    await vi.advanceTimersByTimeAsync(10);

    expect(running.acknowledged.get(FLEET_ID)).toBe(21);
  });

  it('one slow fleet does not block another', async () => {
    const held = Promise.withResolvers<undefined>();
    const running = await aWatch({ fleets: [FLEET_ID, OTHER_FLEET_ID], once: async (fleetId) => {
      if (fleetId === FLEET_ID) { await held.promise; }
      return ok({ acknowledged: 0 });
    } });
    try {
      running.wake(0);
      running.wake(1);
      await flush();

      expect(running.received.map((call) => call.fleetId)).toEqual([FLEET_ID, OTHER_FLEET_ID]);
    } finally { held.resolve(undefined); }
  });

  it('restart receives stored deliveries on the new open wake', async () => {
    const first = await aWatch();
    await first.watch.stop();
    const restarted = await aWatch({ connections: first.connections });
    restarted.remaining.set(FLEET_ID, 1);

    restarted.wake();
    await vi.advanceTimersByTimeAsync(10);

    expect(restarted.acknowledged.get(FLEET_ID)).toBe(1);
  });

  it('switching a fleet off aborts its stream and nothing reopens', async () => {
    const running = await aWatch();

    running.enabled.clear();
    await running.watch.rescan();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(running.streams.map((stream) => stream.signal?.aborted)).toEqual([true]);
  });

  it('switching a fleet off aborts its receive', async () => {
    const held = Promise.withResolvers<undefined>();
    const running = await aWatch({ once: async () => { await held.promise; return ok({ acknowledged: 0 }); } });
    running.wake();
    await flush();
    try {
      running.enabled.clear();
      await running.watch.rescan();

      expect(running.received[0]?.signal.aborted).toBe(true);
    } finally { held.resolve(undefined); }
  });

  it('an unserved fleet gets no stream', async () => {
    const running = await aWatch({ isServed: () => Promise.resolve(false) });

    await running.watch.rescan();

    expect(running.streams).toHaveLength(0);
  });

  it('a fleet switched on gets its stream on rescan', async () => {
    const running = await aWatch({ fleets: [] });
    await running.connections.save({ fleetId: FLEET_ID, shipId: SHIP_ID, name: 'watch', crewToken: 'new', crewedAt: new Date('2026-11-15') });
    running.enabled.add(FLEET_ID);

    await vi.advanceTimersByTimeAsync(5000);

    expect(running.streams.map((stream) => stream.token)).toEqual(['new']);
  });

  it('replacing the connection aborts the old stream and opens the new lease', async () => {
    const running = await aWatch();
    await running.connections.save({ fleetId: FLEET_ID, shipId: SHIP_ID, name: 'watch', crewToken: 'replacement', crewedAt: new Date('2026-11-15') });

    await running.watch.rescan();

    expect(running.streams.map((stream) => ({ token: stream.token, isAborted: stream.signal?.aborted }))).toEqual([
      { token: FLEET_ID, isAborted: true }, { token: 'replacement', isAborted: false },
    ]);
  });

  it('dropping the connection stops its stream', async () => {
    const running = await aWatch();

    await running.connections.drop(FLEET_ID);
    await running.watch.rescan();

    expect(running.streams[0]?.signal?.aborted).toBe(true);
  });

  it('a lease-ended stream drops the held connection', async () => {
    const running = await aWatch();

    running.streams[0]?.writer?.enqueue(new TextEncoder().encode('event: end\ndata: {"code":"LEASE_ENDED","message":"ended"}\n\n'));
    await flush();

    await expect(running.connections.find(FLEET_ID)).resolves.toBeUndefined();
  });

  it('a late end from the old lease keeps the replacement connection', async () => {
    const running = await aWatch();
    await running.connections.save({ fleetId: FLEET_ID, shipId: SHIP_ID, name: 'watch', crewToken: 'replacement', crewedAt: new Date('2026-11-15') });

    running.streams[0]?.writer?.enqueue(new TextEncoder().encode('event: end\ndata: {"code":"LEASE_ENDED","message":"ended"}\n\n'));
    await flush();

    await expect(running.connections.find(FLEET_ID)).resolves.toMatchObject({ crewToken: 'replacement' });
  });

  it('shutdown aborts every stream and nothing reopens', async () => {
    const running = await aWatch({ fleets: [FLEET_ID, OTHER_FLEET_ID] });

    await running.watch.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    await running.watch.rescan();

    expect(running.streams.map((stream) => stream.signal?.aborted)).toEqual([true, true]);
  });

  it('shutdown aborts an in-flight receive', async () => {
    const held = Promise.withResolvers<undefined>();
    const running = await aWatch({ once: async () => { await held.promise; return ok({ acknowledged: 0 }); } });
    running.wake();
    await flush();

    const stopped = running.watch.stop();
    held.resolve(undefined);
    await stopped;

    expect(running.received[0]?.signal.aborted).toBe(true);
  });

  it('shutdown waits for delivery handling before closing', async () => {
    const held = Promise.withResolvers<undefined>();
    const running = await aWatch({ once: async () => { await held.promise; return ok({ acknowledged: 0 }); } });
    running.wake();
    await flush();
    let hasStopped = false;

    const stopped = running.watch.stop().then(() => { hasStopped = true; });
    await flush();
    expect(hasStopped).toBe(false);
    held.resolve(undefined);
    await stopped;

    expect(hasStopped).toBe(true);
  });

  it('shutdown during a rescan never starts a stream afterwards', async () => {
    const connections = memoryConnectionStore();
    const snapshot = Promise.withResolvers<Awaited<ReturnType<ConnectionStore['connected']>>>();
    let isHeld = false;
    const running = await aWatch({ connections: { ...connections, connected: () => isHeld ? snapshot.promise : connections.connected() } });
    isHeld = true;

    const scan = running.watch.rescan();
    const stopped = running.watch.stop();
    snapshot.resolve(await connections.connected());
    await Promise.all([scan, stopped]);

    expect(running.streams).toHaveLength(1);
  });
});


describe('fleet receive cancellation and retry boundaries', () => {
  it('a late NOT_CONNECTED answer cannot stop the replacement stream', async () => {
    const held = Promise.withResolvers<undefined>();
    const running = await aWatch({ once: async () => { await held.promise; return refuse('NOT_CONNECTED', 'old lease ended'); } });
    running.wake();
    await vi.advanceTimersByTimeAsync(1);

    await running.connections.save({ fleetId: FLEET_ID, shipId: SHIP_ID, name: 'watch', crewToken: 'replacement', crewedAt: new Date('2026-11-15') });
    await running.watch.rescan();
    held.resolve(undefined);
    await flush();

    expect(running.streams[1]?.signal?.aborted).toBe(false);
  });

  it('a NOT_CONNECTED receive stops its stream', async () => {
    const running = await aWatch({ once: () => Promise.resolve(refuse('NOT_CONNECTED', 'lease ended')) });

    running.wake();
    await vi.advanceTimersByTimeAsync(1);

    expect(running.streams[0]?.signal?.aborted).toBe(true);
  });

  it.each(['refusal', 'network error'])('a receive $0 retries after the existing pause', async (reason) => {
    let attempts = 0;
    const running = await aWatch({ once: () => {
      attempts += 1;
      if (attempts > 1) { return Promise.resolve(ok({ acknowledged: 0 })); }
      return reason === 'refusal' ? Promise.resolve(err({ kind: 'FLEET_UNAVAILABLE', message: 'down' })) : Promise.reject(new Error('network down'));
    } });

    running.wake();
    await vi.advanceTimersByTimeAsync(1000);
    expect(running.received).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(running.received).toHaveLength(2);
  });

  it('a wake after token replacement cannot receive on the old stream', async () => {
    const running = await aWatch();
    await running.connections.save({ fleetId: FLEET_ID, shipId: SHIP_ID, name: 'watch', crewToken: 'replacement', crewedAt: new Date('2026-11-15') });

    running.wake();
    await flush();

    expect(running.received).toHaveLength(0);
  });

  it('a fleet switched off cannot receive before its next rescan', async () => {
    const running = await aWatch();
    running.enabled.clear();

    running.wake();
    await flush();

    expect(running.received).toHaveLength(0);
  });

  it('shutdown while a receive checks the switch cannot start the receive', async () => {
    const served = Promise.withResolvers<boolean>();
    let isHeld = false;
    const running = await aWatch({ isServed: () => isHeld ? served.promise : Promise.resolve(true) });
    isHeld = true;
    running.wake();
    await flush();

    const stopped = running.watch.stop();
    served.resolve(true);
    await stopped;

    expect(running.received).toHaveLength(0);
  });

  it('shutdown while a rescan checks switches cannot open another stream', async () => {
    const served = Promise.withResolvers<boolean>();
    let isHeld = false;
    const running = await aWatch({ isServed: () => isHeld ? served.promise : Promise.resolve(true) });
    await running.connections.save({ fleetId: OTHER_FLEET_ID, shipId: SHIP_ID, name: 'watch', crewToken: 'other', crewedAt: new Date('2026-11-15') });
    isHeld = true;
    const scan = running.watch.rescan();
    await flush();

    const stopped = running.watch.stop();
    served.resolve(true);
    await Promise.all([scan, stopped]);

    expect(running.streams).toHaveLength(1);
  });
});

it('shutdown never reads switches after a held connection scan returns', async () => {
  const connections = memoryConnectionStore();
  const snapshot = Promise.withResolvers<Awaited<ReturnType<ConnectionStore['connected']>>>();
  let isHeld = false;
  let reads = 0;
  const running = await aWatch({
    connections: { ...connections, connected: () => isHeld ? snapshot.promise : connections.connected() },
    isServed: () => { reads += 1; return Promise.resolve(true); },
  });
  isHeld = true;

  const scan = running.watch.rescan();
  const stopped = running.watch.stop();
  snapshot.resolve(await connections.connected());
  await Promise.all([scan, stopped]);

  expect(reads).toBe(1);
});

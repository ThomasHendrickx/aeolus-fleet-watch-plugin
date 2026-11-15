/** REST wake hints drive serialized looks; bytes, including comments, keep the connection alive. */
import { refusalSchema } from './refusal-schema.js';

const INITIAL_BACKOFF_MS = 1_000;
const BACKOFF_SPREAD_MS = 4_000;
const EVENT_PREFIX = 'event:';
const DATA_PREFIX = 'data:';

const SILENCE_MS = 60_000;
const SAFETY_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60_000;

interface WakeupsOptions {
  fleetUrl: string;
  fetch?: typeof fetch;
  random?: () => number;
  look: () => Promise<void>;
  ended: () => Promise<void>;
  failed: (error: unknown) => void;
}

/** Opens one stream for a lease, returning its cancellation function. Deliveries always come from look. */
export function createShipWakeups(options: WakeupsOptions): (crewToken: string) => () => void {
  return (crewToken) => {
    const state = { isStopped: false, isPending: false };
    const isActive = () => !state.isStopped;
    const hasPending = () => state.isPending;
    let isLooking = false;
    let safety: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let abort: AbortController | undefined;
    const initialBackoff = () => INITIAL_BACKOFF_MS + (options.random ?? Math.random)() * BACKOFF_SPREAD_MS;
    let backoffMs = initialBackoff();
    const stop = () => {
      state.isStopped = true;
      clearTimeout(safety);
      clearTimeout(retry);
      abort?.abort();
    };
    const ended = () => {
      stop();
      void options.ended().catch(options.failed);
    };
    const look = async (): Promise<void> => {
      if (state.isStopped) { return; }
      clearTimeout(safety);
      safety = setTimeout(() => { void look(); }, SAFETY_MS);
      if (isLooking) { state.isPending = true; return; }
      isLooking = true;
      do {
        state.isPending = false;
        await options.look().catch(options.failed);
      } while (hasPending() && isActive());
      isLooking = false;
    };
    const open = async (): Promise<void> => {
      const controller = new AbortController();
      const isReading = () => isActive() && !controller.signal.aborted;
      abort = controller;
      let silence = setTimeout(() => { controller.abort(); }, SILENCE_MS);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancel = () => { void reader?.cancel().catch(options.failed); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        const response = await (options.fetch ?? fetch)(`${options.fleetUrl}/api/v1/ship/wakeups`, {
          headers: { authorization: `Bearer ${crewToken}`, accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!isReading()) { await response.body?.cancel(); return; }
        if (response.status === 401) {
          const refusal = refusalSchema.safeParse(await response.json());
          if (!isReading()) { return; }
          if (refusal.success && refusal.data.code === 'LEASE_ENDED') {
            ended();
            return;
          }
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          return;
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        let event = '';
        let data = '';
        while (isReading()) {
          const read = await reader.read();
          if (read.done || !isReading()) { break; }
          clearTimeout(silence);
          silence = setTimeout(() => { controller.abort(); }, SILENCE_MS);
          pending += decoder.decode(read.value, { stream: true });
          let newline: number;
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline).replace(/\r$/, '');
            pending = pending.slice(newline + 1);
            if (line === '') {
              if (event === 'wake') {
                backoffMs = initialBackoff();
                void look();
              } else if (event === 'end') {
                const refusal = refusalSchema.safeParse(JSON.parse(data));
                if (refusal.success && refusal.data.code === 'LEASE_ENDED') { ended(); }
              }
              event = '';
              data = '';
            } else if (line.startsWith(EVENT_PREFIX)) {
              event = line.slice(EVENT_PREFIX.length).trim();
            } else if (line.startsWith(DATA_PREFIX)) {
              data += line.slice(DATA_PREFIX.length).trim();
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) { options.failed(error); }
      } finally {
        clearTimeout(silence);
        controller.signal.removeEventListener('abort', cancel);
        await reader?.cancel().catch(options.failed);
        if (!state.isStopped) {
          retry = setTimeout(() => { void open(); }, backoffMs);
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        }
      }
    };
    safety = setTimeout(() => { void look(); }, SAFETY_MS);
    void open();
    return stop;
  };
}

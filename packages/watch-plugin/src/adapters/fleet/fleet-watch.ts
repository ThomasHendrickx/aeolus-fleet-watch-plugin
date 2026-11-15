/** One wake stream per served fleet, with independent, serialized receive turns. */
import type { FleetId } from '@aeolus-fleet/common';
import type { FastifyBaseLogger } from 'fastify';

import type { DropEndedCrew } from '../../core/connection/drop-ended-crew.js';
import type { ConnectionStore } from '../../core/connection/ports.js';
import type { IsServed } from '../../core/installation/served.js';
import type { ReceiveOnce } from '../../core/inbox/receive-once.js';

export type FleetCallOnce = (fleetId: FleetId, until: { signal: AbortSignal }) => ReturnType<ReceiveOnce>;

/** Receive failures retain the existing retry pause and the fleet door's busy waits. */
const RETRY_MS = 1_000;
const RECEIVE_PAGE_SIZE = 10;

export interface FleetWatch {
  /** Reconciles streams with the connected fleets the watch plugin serves. */
  rescan(): Promise<void>;
  /** Aborts streams and receives, then waits for acknowledgements before the database closes. */
  stop(): Promise<void>;
}

export function watchFleets(deps: {
  once: FleetCallOnce;
  doing: string;
  connections: ConnectionStore;
  dropEndedCrew: DropEndedCrew;
  isServed: IsServed;
  log: FastifyBaseLogger;
  rescanMs: number;
  start: (crewToken: string, events: { look: () => Promise<void>; ended: () => Promise<void> }) => () => void;
}): FleetWatch {
  let isStopped = false;
  const hasStopped = () => isStopped;
  const watched = new Map<FleetId, { crewToken: string; stop: () => void }>();
  const running = new Set<Promise<void>>();
  const track = (work: Promise<void>): Promise<void> => {
    running.add(work);
    void work.then(() => running.delete(work), () => running.delete(work));
    return work;
  };

  const start = (fleetId: FleetId, crewToken: string) => {
    const stopping = new AbortController();
    const isStopping = () => stopping.signal.aborted;
    const pause = () => new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); stopping.signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, RETRY_MS);
      stopping.signal.addEventListener('abort', done, { once: true });
      if (isStopping()) { done(); }
    });
    const ended = async () => {
      const stream = watched.get(fleetId);
      if (stream?.crewToken === crewToken) { stream.stop(); }
      await deps.dropEndedCrew(fleetId, crewToken);
    };
    const look = async (): Promise<void> => {
      while (!isStopping()) {
        const crew = await deps.connections.find(fleetId);
        if (crew?.crewToken !== crewToken || !(await deps.isServed(fleetId))) { return; }
        if (isStopping()) { return; }
        try {
          const received = await deps.once(fleetId, { signal: stopping.signal });
          if (isStopping()) { return; }
          if (!received.isOk) {
            if (received.error.kind === 'NOT_CONNECTED') { watched.get(fleetId)?.stop(); return; }
            deps.log.warn({ fleet: fleetId, refusal: received.error }, `the watch plugin could not go on ${deps.doing}; it tries again`);
            await pause();
            continue;
          }
          if (received.value.acknowledged < RECEIVE_PAGE_SIZE) { return; }
        } catch (error) {
          if (isStopping()) { return; }
          deps.log.error({ err: error, fleet: fleetId }, `the watch plugin failed ${deps.doing}; it tries again`);
          await pause();
        }
      }
    };
    const stopStream = deps.start(crewToken, { look: () => track(look()), ended: () => track(ended()) });
    return { crewToken, stop: () => { stopping.abort(); stopStream(); } };
  };

  const reconcile = async (): Promise<void> => {
    const connected = await deps.connections.connected();
    if (hasStopped()) { return; }
    const served = await Promise.all(connected.map(async (crew) => ({ crew, isServed: await deps.isServed(crew.fleetId) })));
    if (hasStopped()) { return; }
    const leases = new Map(served.filter((each) => each.isServed).map(({ crew }) => [crew.fleetId, crew.crewToken]));
    for (const [fleetId, stream] of watched) {
      if (leases.get(fleetId) !== stream.crewToken) { stream.stop(); watched.delete(fleetId); }
    }
    for (const [fleetId, crewToken] of leases) {
      if (!watched.has(fleetId)) { watched.set(fleetId, start(fleetId, crewToken)); }
    }
  };
  let scanning: Promise<void> | undefined;
  const rescan = (): Promise<void> => {
    scanning ??= track(reconcile().catch((error: unknown) => {
      deps.log.error({ err: error }, 'the watch plugin could not reconcile fleet streams');
    }).finally(() => { scanning = undefined; }));
    return scanning;
  };
  const timer = setInterval(() => { void rescan(); }, deps.rescanMs);
  return {
    rescan,
    stop: async () => {
      isStopped = true;
      clearInterval(timer);
      for (const stream of watched.values()) { stream.stop(); }
      watched.clear();
      while (running.size > 0) { await Promise.allSettled([...running]); }
    },
  };
}

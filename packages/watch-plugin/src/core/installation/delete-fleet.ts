import type { FleetId } from '@aeolus-fleet/common';

import type { ConnectionStore, FleetDoor } from '../connection/ports.js';
import type { Clock } from '../shared/clock.js';
import { refuse, type DomainError } from '../shared/errors.js';
import { ok, type Result } from '../shared/result.js';
import type { FleetForgetter, InstallationRequests, RequestHasher } from './ports.js';
import { earlierAnswer } from './request-id.js';

export type DeleteFleet = (input: { requestId: string; fleetId: FleetId }) => Promise<Result<Record<string, never>, DomainError<'REQUEST_ID_USED' | 'FLEET_UNAVAILABLE'>>>;

/** The codes with which the fleet says nothing is left to deregister: the crew token no longer crews its ship. */
const NOTHING_TO_DEREGISTER = new Set(['LEASE_ENDED', 'UNAUTHORIZED']);

/**
 * Use case: the hosting service deletes a fleet from the watch plugin
 * (decisions 0021, 0072): it deregisters its ship from the fleet first, then forgets everything it holds of the fleet. A fleet must
 * never be left with a plugin nobody can deregister, so while the fleet does
 * not answer the delete is refused and forgets nothing, for the hosting
 * service to retry. The request is kept as its hash only, so nothing of the
 * fleet stays; a replay answers the first answer.
 */
export function createDeleteFleet(deps: {
  forgetter: FleetForgetter;
  requests: InstallationRequests;
  hasher: RequestHasher;
  clock: Clock;
  door: FleetDoor;
  connections: ConnectionStore;
}): DeleteFleet {
  return async ({ requestId, fleetId }) => {
    const requestHash = deps.hasher.hash(`deleteFleet ${fleetId}`);
    const earlier = await earlierAnswer(deps.requests, { requestId, requestHash });
    if (earlier !== undefined) {
      return 'isOk' in earlier ? earlier : ok({});
    }
    const crew = await deps.connections.find(fleetId);
    if (crew) {
      const deregistered = await deps.door.deregister(crew.crewToken);
      if (!deregistered.isOk && !NOTHING_TO_DEREGISTER.has(deregistered.error.code)) {
        return refuse('FLEET_UNAVAILABLE', `The fleet did not let the watch plugin deregister: ${deregistered.error.message}`);
      }
    }
    await deps.forgetter.forget(fleetId);
    await deps.requests.record({ requestId, kind: 'deleteFleet', requestHash, fleetId: null, isEnabled: null, at: deps.clock.now() });
    return ok({});
  };
}

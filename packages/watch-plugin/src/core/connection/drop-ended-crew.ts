import type { FleetId } from '@aeolus-fleet/common';

import type { ConnectionStore } from './ports.js';

export type DropEndedCrew = (fleetId: FleetId, crewToken: string) => Promise<void>;

/**
 * Use case: the fleet no longer takes a crew token (its lease ended), so the
 * watch plugin forgets it and is not connected to that fleet until its
 * operator connects it again. A connection made since with another crew
 * token is kept: an answer about the old crew token says nothing about it.
 */
export function createDropEndedCrew(deps: { connections: ConnectionStore }): DropEndedCrew {
  return async (fleetId, crewToken) => {
    if ((await deps.connections.find(fleetId))?.crewToken === crewToken) {
      await deps.connections.drop(fleetId);
    }
  };
}

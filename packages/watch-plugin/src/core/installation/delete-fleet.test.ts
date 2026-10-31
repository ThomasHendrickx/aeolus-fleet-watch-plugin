import type { FleetId } from '@aeolus-fleet/common';
import { beforeEach, describe, expect, it } from 'vitest';

import { FLEET_ID, connectedCrew, fakePluginFleet, memoryConnectionStore } from '../../../test/support/connection-fakes.js';
import { memoryFleetSwitches, memoryForgetter, memoryInstallationRequests, plainHasher } from '../../../test/support/memory-installation.js';
import { createDeleteFleet } from './delete-fleet.js';

const FLEET: FleetId = FLEET_ID;
const OTHER: FleetId = 'flt_01m3tb1zgr5h2ffee12xnch8zz';
const AT = new Date('2026-10-04T12:00:00.000Z');

let switches: ReturnType<typeof memoryFleetSwitches>;
let requests: ReturnType<typeof memoryInstallationRequests>;
let forgetter: ReturnType<typeof memoryForgetter>;
let deleteFleet: ReturnType<typeof createDeleteFleet>;
let fleet: ReturnType<typeof fakePluginFleet>;

beforeEach(async () => {
  fleet = fakePluginFleet();
  const connections = memoryConnectionStore();
  await connectedCrew(fleet, connections);
  switches = memoryFleetSwitches();
  requests = memoryInstallationRequests();
  forgetter = memoryForgetter({ switches, requests });
  deleteFleet = createDeleteFleet({ forgetter, requests, hasher: plainHasher, clock: { now: () => AT }, door: fleet.door, connections });
  await switches.set(FLEET, { isEnabled: true, at: AT });
});

describe('deleting a fleet from the watch plugin', () => {
  it('forgets everything of the fleet, its switch included, and keeps a request that names nothing of it', async () => {
    await expect(deleteFleet({ requestId: 'r-1', fleetId: FLEET })).resolves.toEqual({ isOk: true, value: {} });

    expect(forgetter.forgotten).toEqual([FLEET]);
    expect(switches.held.has(FLEET)).toBe(false);
    expect(requests.held).toEqual([{ requestId: 'r-1', kind: 'deleteFleet', requestHash: plainHasher.hash(`deleteFleet ${FLEET}`), fleetId: null, isEnabled: null, at: AT }]);
  });

  it('answers a replayed request id with its first answer, forgetting nothing again', async () => {
    await deleteFleet({ requestId: 'r-1', fleetId: FLEET });

    await expect(deleteFleet({ requestId: 'r-1', fleetId: FLEET })).resolves.toEqual({ isOk: true, value: {} });
    expect(forgetter.forgotten).toEqual([FLEET]);
  });

  it('refuses a request id used for another request', async () => {
    await deleteFleet({ requestId: 'r-1', fleetId: FLEET });

    await expect(deleteFleet({ requestId: 'r-1', fleetId: OTHER })).resolves.toMatchObject({ isOk: false, error: { kind: 'REQUEST_ID_USED' } });
    expect(forgetter.forgotten).toEqual([FLEET]);
  });
});

describe('deleting a fleet the watch plugin is connected to (decision 0072)', () => {
  it('deregisters its ship at the fleet first', async () => {
    await expect(deleteFleet({ requestId: 'r-1', fleetId: FLEET })).resolves.toEqual({ isOk: true, value: {} });

    expect(fleet.state.deregistered).toEqual(['aeolus_ct_v1_1']);
  });

  it('is refused while the fleet does not answer, forgetting nothing, so the same request id deletes it once the fleet answers', async () => {
    fleet.state.isAnswering = false;

    await expect(deleteFleet({ requestId: 'r-1', fleetId: FLEET })).resolves.toMatchObject({ isOk: false, error: { kind: 'FLEET_UNAVAILABLE' } });
    expect(forgetter.forgotten).toEqual([]);
    expect(requests.held).toEqual([]);

    fleet.state.isAnswering = true;
    await expect(deleteFleet({ requestId: 'r-1', fleetId: FLEET })).resolves.toEqual({ isOk: true, value: {} });
    expect(fleet.state.deregistered).toEqual(['aeolus_ct_v1_1']);
    expect(forgetter.forgotten).toEqual([FLEET]);
  });

  it('goes on when the fleet says its crew token no longer crews its ship: nothing is left to deregister', async () => {
    fleet.state.liveTokens.clear();

    await expect(deleteFleet({ requestId: 'r-1', fleetId: FLEET })).resolves.toEqual({ isOk: true, value: {} });
    expect(forgetter.forgotten).toEqual([FLEET]);
  });
});

import { describe, expect, it } from 'vitest';

import { fakePluginFleet, FLEET_ID, memoryConnectionStore, SHIP_ID } from '../../../test/support/connection-fakes.js';
import { memoryFleetSwitches, memoryInstallationRequests, plainHasher } from '../../../test/support/memory-installation.js';
import { createConnect } from '../connection/connect.js';
import { createInstallationConnect } from './installation-connect.js';
import { createIsServed } from './served.js';

const clock = { now: () => new Date('2026-11-18T10:00:00Z') };

function scenario() {
  const fleet = fakePluginFleet();
  const connections = memoryConnectionStore();
  const requests = memoryInstallationRequests();
  const switches = memoryFleetSwitches();
  switches.held.set(FLEET_ID, true);
  const deps = { requests, hasher: plainHasher, clock, isServed: createIsServed({ installation: 'enabled', switches }), connect: createConnect({ door: fleet.door, store: connections, clock }) };
  const input = { requestId: 'connect-request', fleetId: FLEET_ID, shipId: SHIP_ID, secret: fleet.state.secret };
  return { fleet, connections, requests, switches, deps, input, connect: createInstallationConnect(deps) };
}

describe('installation connect receipts', () => {
  it('replays success after restart excluding the secret from request identity', async () => {
    // Given a successful request.
    const s = scenario();
    expect(await s.connect(s.input)).toEqual({ isOk: true, value: { isEnabled: true, isConnected: true } });

    // When the use case restarts and the secret changes.
    const answer = await createInstallationConnect(s.deps)({ ...s.input, secret: 'fresh-secret' });

    // Then only the successful receipt is returned, without registering again.
    expect(answer).toEqual({ isOk: true, value: { isEnabled: true, isConnected: true } });
    expect(s.fleet.state.registers).toBe(1);
    expect(s.requests.held).toHaveLength(1);
    expect(s.requests.held[0]?.requestHash).toBe(`hash(connect ${FLEET_ID} ${SHIP_ID})`);
    expect(JSON.stringify(s.requests.held)).not.toContain(s.input.secret);
  });

  it('checks off before replay and records only successful hand-overs', async () => {
    // Given a refused hand-over.
    const s = scenario();
    expect(await s.connect({ ...s.input, secret: 'wrong' })).toMatchObject({ isOk: false, error: { kind: 'SECRET_REFUSED' } });
    expect(s.requests.held).toHaveLength(0);

    // When the same id succeeds with a fresh secret, then the fleet is switched off.
    expect(await s.connect(s.input)).toMatchObject({ isOk: true });
    s.switches.held.set(FLEET_ID, false);

    // Then off wins over the successful receipt and the connection is retained.
    expect(await s.connect(s.input)).toMatchObject({ isOk: false, error: { kind: 'OFF' } });
    expect(await s.connections.find(FLEET_ID)).toMatchObject({ shipId: SHIP_ID });
  });

  it('resolves the save-before-receipt failure window through current state, without replacing the connection', async () => {
    // Given durable connection storage but a failed receipt write.
    const s = scenario();
    const failing = createInstallationConnect({ ...s.deps, requests: { ...s.requests, record: () => Promise.reject(new Error('receipt unavailable')) } });

    // When saving the connection succeeds and receipt recording fails.
    await expect(failing(s.input)).rejects.toThrow('receipt unavailable');

    // Then current state holds the connection and retry preserves ALREADY_CONNECTED.
    expect(await s.connections.find(FLEET_ID)).toMatchObject({ shipId: SHIP_ID });
    expect(await s.connect(s.input)).toMatchObject({ isOk: false, error: { kind: 'ALREADY_CONNECTED' } });
    expect(s.fleet.state.registers).toBe(1);
    expect(s.requests.held).toHaveLength(0);
  });
});

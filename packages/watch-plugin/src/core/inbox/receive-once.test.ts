import { beforeEach, describe, expect, it } from 'vitest';

import { FLEET_ID, connectedCrew, fakePluginFleet, memoryConnectionStore } from '../../../test/support/connection-fakes.js';
import { createReceiveOnce } from './receive-once.js';

let fleet: ReturnType<typeof fakePluginFleet>;
let connections: ReturnType<typeof memoryConnectionStore>;
let receiveOnce: ReturnType<typeof createReceiveOnce>;

beforeEach(() => {
  fleet = fakePluginFleet();
  connections = memoryConnectionStore();
  receiveOnce = createReceiveOnce({ door: fleet.door, connections });
});

describe("the watch plugin's ship receiving", () => {
  it('acknowledges every delivery waiting for it and acts on none: a ship acknowledges on receipt', async () => {
    await connectedCrew(fleet, connections);
    fleet.state.waiting = ['dlv_01m3tbfspe96yf1rnr4ank9001', 'dlv_01m3tbfspe96yf1rnr4ank9002'];

    await expect(receiveOnce(FLEET_ID)).resolves.toEqual({ isOk: true, value: { acknowledged: 2 } });
    expect(fleet.state.acked).toEqual(['dlv_01m3tbfspe96yf1rnr4ank9001', 'dlv_01m3tbfspe96yf1rnr4ank9002']);
    expect(fleet.state.waiting).toEqual([]);
  });

  it("answers argo's ping with pong, not a plain ack, and acknowledges the rest", async () => {
    await connectedCrew(fleet, connections);
    fleet.state.waiting = ['dlv_01m3tbfspe96yf1rnr4ank9001', 'dlv_01m3tbfspe96yf1rnr4ank9002'];
    fleet.state.pings.add('dlv_01m3tbfspe96yf1rnr4ank9002');

    await expect(receiveOnce(FLEET_ID)).resolves.toEqual({ isOk: true, value: { acknowledged: 2 } });
    expect(fleet.state.ponged).toEqual(['dlv_01m3tbfspe96yf1rnr4ank9002']);
    expect(fleet.state.acked).toEqual(['dlv_01m3tbfspe96yf1rnr4ank9001']);
    expect(fleet.state.waiting).toEqual([]);
  });

  it('is refused while the fleet does not take the pong', async () => {
    await connectedCrew(fleet, connections);
    fleet.state.waiting = ['dlv_01m3tbfspe96yf1rnr4ank9001'];
    fleet.state.pings.add('dlv_01m3tbfspe96yf1rnr4ank9001');
    fleet.state.isTakingPongs = false;

    await expect(receiveOnce(FLEET_ID)).resolves.toMatchObject({ isOk: false, error: { kind: 'FLEET_UNAVAILABLE' } });
    expect(fleet.state.acked).toEqual([]);
  });

  it('receives nothing for a fleet it is not connected to', async () => {
    await expect(receiveOnce(FLEET_ID)).resolves.toMatchObject({ isOk: false, error: { kind: 'NOT_CONNECTED' } });
  });

  it('drops a crew token the fleet no longer takes: not connected until argo connects it again', async () => {
    await connectedCrew(fleet, connections);
    fleet.state.liveTokens.clear();

    await expect(receiveOnce(FLEET_ID)).resolves.toMatchObject({ isOk: false, error: { kind: 'NOT_CONNECTED' } });
    await expect(connections.find(FLEET_ID)).resolves.toBeUndefined();
  });

  it('a late LEASE_ENDED for the old crew token keeps the connection made meanwhile', async () => {
    const crew = await connectedCrew(fleet, connections);
    const held = Promise.withResolvers<undefined>();
    const receive = createReceiveOnce({ connections, door: { ...fleet.door, receive: async (...args) => { await held.promise; return fleet.door.receive(...args); } } });
    const result = receive(FLEET_ID);
    await Promise.resolve();

    fleet.state.liveTokens.clear();
    await connections.save({ ...crew, crewToken: 'replacement' });
    held.resolve(undefined);

    await expect(result).resolves.toMatchObject({ isOk: false, error: { kind: 'NOT_CONNECTED' } });
    await expect(connections.find(FLEET_ID)).resolves.toMatchObject({ crewToken: 'replacement' });
  });

  it('is refused while the fleet does not answer, keeping the crew token', async () => {
    await connectedCrew(fleet, connections);
    fleet.state.isAnswering = false;

    await expect(receiveOnce(FLEET_ID)).resolves.toMatchObject({ isOk: false, error: { kind: 'FLEET_UNAVAILABLE' } });
    await expect(connections.find(FLEET_ID)).resolves.toBeDefined();
  });
});

describe('cancelled wake receives', () => {
  it('a cancelled connection lookup never starts a receive', async () => {
    const crew = await connectedCrew(fleet, connections);
    const found = Promise.withResolvers<typeof crew>();
    let receives = 0;
    const receive = createReceiveOnce({
      connections: { ...connections, find: () => found.promise },
      door: { ...fleet.door, receive: (...args) => { receives += 1; return fleet.door.receive(...args); } },
    });
    const stopping = new AbortController();

    const result = receive(FLEET_ID, { signal: stopping.signal });
    stopping.abort();
    found.resolve(crew);
    await result;

    expect(receives).toBe(0);
  });

  it('a late receive refusal after shutdown keeps the replacement connection', async () => {
    const crew = await connectedCrew(fleet, connections);
    const held = Promise.withResolvers<undefined>();
    const receive = createReceiveOnce({ connections, door: { ...fleet.door, receive: async (...args) => { await held.promise; return fleet.door.receive(...args); } } });
    const stopping = new AbortController();
    const result = receive(FLEET_ID, { signal: stopping.signal });
    await Promise.resolve();

    stopping.abort();
    fleet.state.liveTokens.clear();
    await connections.save({ ...crew, crewToken: 'replacement' });
    held.resolve(undefined);
    await result;

    await expect(connections.find(FLEET_ID)).resolves.toMatchObject({ crewToken: 'replacement' });
  });

  it('a late receive page after shutdown is left unacknowledged', async () => {
    await connectedCrew(fleet, connections);
    fleet.state.waiting = ['dlv_01m3tbfspe96yf1rnr4ank9001'];
    const held = Promise.withResolvers<undefined>();
    const receive = createReceiveOnce({ connections, door: { ...fleet.door, receive: async (...args) => { const answer = await fleet.door.receive(...args); await held.promise; return answer; } } });
    const stopping = new AbortController();
    const result = receive(FLEET_ID, { signal: stopping.signal });
    await Promise.resolve();

    stopping.abort();
    held.resolve(undefined);
    await result;

    expect(fleet.state.acked).toEqual([]);
  });
});

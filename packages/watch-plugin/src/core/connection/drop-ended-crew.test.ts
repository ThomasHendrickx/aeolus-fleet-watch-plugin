import { beforeEach, describe, expect, it } from 'vitest';

import { FLEET_ID, connectedCrew, fakePluginFleet, memoryConnectionStore } from '../../../test/support/connection-fakes.js';
import { createDropEndedCrew } from './drop-ended-crew.js';

let fleet: ReturnType<typeof fakePluginFleet>;
let connections: ReturnType<typeof memoryConnectionStore>;
let dropEndedCrew: ReturnType<typeof createDropEndedCrew>;

beforeEach(() => {
  fleet = fakePluginFleet();
  connections = memoryConnectionStore();
  dropEndedCrew = createDropEndedCrew({ connections });
});

describe('dropping a crew token the fleet no longer takes', () => {
  it('drops the connection while it holds that crew token', async () => {
    const crew = await connectedCrew(fleet, connections);

    await dropEndedCrew(FLEET_ID, crew.crewToken);

    await expect(connections.find(FLEET_ID)).resolves.toBeUndefined();
  });

  it('keeps a connection made since with another crew token', async () => {
    const crew = await connectedCrew(fleet, connections);
    await connections.save({ ...crew, crewToken: 'replacement' });

    await dropEndedCrew(FLEET_ID, crew.crewToken);

    await expect(connections.find(FLEET_ID)).resolves.toMatchObject({ crewToken: 'replacement' });
  });
});

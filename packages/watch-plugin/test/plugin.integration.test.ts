import type { ShipId } from '@aeolus-fleet/common';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createApp, createMigratedDatabase, createPrismaClient, createUseCases, FLEET_URL, newKey, OPERATOR, operatorCaller, secretOf, unwrap, type PrismaClient } from '@aeolus-fleet/core/testing';

import { createWatchPluginApp, type WatchPluginApp } from '../src/app.js';
import { connectPlugin, query, signIn } from './support/connection.js';
import { createPrismaClient as createPluginPrismaClient } from '../src/adapters/prisma/client.js';
import { createPluginDatabase } from '../src/testing/database.js';

// The watch plugin against a real fleet: it starts not connected, with no
// secret anywhere; the operator connects it as its ship (fleet:read, fleet:alert),
// keeps the crew token in its own database and is connected
// again after a restart.

/** The existing core receive wait, also exercised by wake-triggered empty receives. */
const RECEIVE_WAIT_MS = 500;

let fleetDatabase: PrismaClient;
let fleet: FastifyInstance;
let fleetUrl: string;
let pluginDatabaseUrl: string;
let useCases: ReturnType<typeof createUseCases>;
let argo: ReturnType<typeof operatorCaller>;
let shipId: ShipId;
let secret: string;
let cookie: string;
const apps: WatchPluginApp[] = [];
let asked: string[];
let completedReceives: number;
let isDeregisterUnavailable: boolean;

beforeEach(async () => {
  const fleetDatabaseUrl = await createMigratedDatabase();
  fleetDatabase = createPrismaClient(fleetDatabaseUrl);
  useCases = createUseCases({ prisma: fleetDatabase });
  argo = operatorCaller(unwrap(await useCases.initialiseFleet({ name: 'home fleet', ...OPERATOR })));
  const commissioned = unwrap(
    await useCases.commissionShip(argo, {
      idempotencyKey: newKey(),
      name: 'watch',
      type: 'watch-plugin',
      scopes: ['fleet:read', 'fleet:alert'],
    }),
  );
  shipId = commissioned.shipId;
  secret = secretOf(commissioned.secret);
  fleet = createApp({ databaseUrl: fleetDatabaseUrl, publicUrl: FLEET_URL, logger: false, receiveWaitMs: RECEIVE_WAIT_MS });
  asked = [];
  completedReceives = 0;
  isDeregisterUnavailable = false;
  fleet.addHook('onRequest', async (request, reply) => {
    asked.push(request.url);
    if (isDeregisterUnavailable && request.url === '/api/v1/ship/deregister') {
      await reply.code(503).send({ code: 'UNAVAILABLE', message: 'Try later' });
    }
  });
  fleet.addHook('onResponse', (request) => { if (request.url === '/api/v1/ship/receive') { completedReceives += 1; } return Promise.resolve(); });
  fleetUrl = await fleet.listen({ host: '127.0.0.1', port: 0 });
  cookie = await signIn(fleetUrl, unwrap(await useCases.issueSignInLink({ fleetId: argo.fleetId })).ticket);
  pluginDatabaseUrl = await createPluginDatabase();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await fleet.close();
  await fleetDatabase.$disconnect();
});

/** A watch plugin process on the test's database, serving on a free port; with an installation token, a fleet is served once switched on. */
async function started(installationToken?: string): Promise<{ app: WatchPluginApp; address: string }> {
  const app = createWatchPluginApp({ databaseUrl: pluginDatabaseUrl, fleetUrl, logger: false, ...(installationToken === undefined ? {} : { installationToken }) });
  apps.push(app);
  await app.restoreConnections();
  return { app, address: await app.server.listen({ host: '127.0.0.1', port: 0 }) };
}

/** A watch plugin process, connected to the fleet. */
async function connected(): Promise<string> {
  const { address } = await started();
  const answer = await connectPlugin(address, { cookie, shipId, secret });
  expect(answer.status, await answer.clone().text()).toBe(200);
  return address;
}

const statusSchema = z.object({
  result: z.object({ data: z.object({ state: z.string(), ship: z.object({ shipId: z.string(), name: z.string() }).nullable(), lastShipId: z.string().nullable() }) }),
});

async function status(address: string) {
  return statusSchema.parse(await (await query(address, { procedure: 'connection.status', cookie })).json()).result.data;
}

describe('a watch plugin process that was never connected', () => {
  it('starts not connected, its health saying only up and its version only the version it runs', async () => {
    const { address } = await started();

    await expect(status(address)).resolves.toEqual({ state: 'not-connected', ship: null, lastShipId: null });
    const health = await fetch(`${address}/api/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok' });
    const version = z.record(z.string(), z.string()).parse(await (await fetch(`${address}/api/version`)).json());
    expect(Object.keys(version)).toEqual(['watchPlugin']);
    expect(version.watchPlugin).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('connecting the watch plugin', () => {
  it('registers its ship with the secret, as a server in the aeolus-watch-plugin harness, and is connected as it', async () => {
    const address = await connected();

    await expect(status(address)).resolves.toEqual({ state: 'connected', ship: { shipId, name: 'watch' }, lastShipId: shipId });
    await expect(fleetDatabase.lease.findFirstOrThrow({ where: { shipId, endedAt: null } })).resolves.toMatchObject({ location: 'SERVER', harness: 'aeolus-watch-plugin' });
  });

  it('is refused for a ship without fleet:alert', async () => {
    const mute = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'reader', type: 'watch-plugin', scopes: ['fleet:read'] }));
    const { address } = await started();

    const refused = await connectPlugin(address, { cookie, shipId: mute.shipId, secret: secretOf(mute.secret) });

    expect(refused.status).toBe(400);
    await expect(status(address)).resolves.toMatchObject({ state: 'not-connected' });
  });

  it('is connected again after a restart with the kept crew token, without a new lease', async () => {
    await connected();
    await apps.splice(0)[0]?.close();

    const { address } = await started();

    await expect(status(address)).resolves.toMatchObject({ state: 'connected' });
    await expect(fleetDatabase.lease.count({ where: { shipId } })).resolves.toBe(1);
  });
});

/** Redeems a sign-in ticket at the fleet: the session cookie it starts. */
async function redeem(ticket: string): Promise<string> {
  const response = await fetch(`${fleetUrl}/trpc/console.redeemSignInTicket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  return z.string().parse(response.headers.getSetCookie().find((each) => each.startsWith('aeolus_session='))).split(';')[0] ?? '';
}

describe("the watch plugin's ship receiving", () => {
  it('acknowledges a message sent to it on receipt, and acts on none', async () => {
    await connected();
    apps[0]?.startReceiving();

    const { messageId } = unwrap(await useCases.sendMessage(argo, { selector: { kind: 'ship', shipId }, payload: 'Hello, watch plugin', idempotencyKey: newKey() }));

    await vi.waitFor(
      async () => {
        await expect(fleetDatabase.delivery.findFirstOrThrow({ where: { messageId } })).resolves.toMatchObject({ state: 'acknowledged' });
      },
      { timeout: 10_000, interval: 100 },
    );
  });

  it("answers argo's ping with pong: the ship's last ping is answered", async () => {
    await connected();
    apps[0]?.startReceiving();

    unwrap(await useCases.pingShip(argo, { shipId }));

    await vi.waitFor(
      async () => {
        await expect(useCases.getShip(argo, { shipId })).resolves.toMatchObject({ isOk: true, value: { ping: { state: 'answered' } } });
      },
      { timeout: 10_000, interval: 100 },
    );
  });
});

describe('a viewer session (decision 0022)', () => {
  it('is refused connecting: only the operator connects the watch plugin', async () => {
    const created = unwrap(await useCases.createFleet({ requestId: newKey(), name: 'demo', operatorEmail: 'demo@example.com', hasViewer: true }));
    const viewerCookie = await redeem(unwrap(await useCases.issueSignInTicket({ fleetId: created.fleetId, as: 'viewer' })).ticket);
    const { address } = await started();

    await expect(connectPlugin(address, { cookie: viewerCookie, shipId, secret }).then((response) => response.status)).resolves.toBe(403);
  });
});

describe('the installation (decision 0021)', () => {
  const TOKEN = 'an-installation-token-of-at-least-32-characters';

  function installation(address: string, request: { procedure: string; body: unknown }): Promise<Response> {
    const headers = { 'content-type': 'application/json', 'x-aeolus-installation-token': TOKEN };
    return request.procedure === 'installation.get'
      ? fetch(`${address}/trpc/installation.get?input=${encodeURIComponent(JSON.stringify(request.body))}`, { headers })
      : fetch(`${address}/trpc/${request.procedure}`, { method: 'POST', headers, body: JSON.stringify(request.body) });
  }

  async function enabled() {
    const running = await started(TOKEN);
    expect((await installation(running.address, { procedure: 'installation.setEnabled', body: { requestId: newKey(), fleetId: argo.fleetId, enabled: true } })).status).toBe(200);
    return running;
  }

  function handover(address: string, body: unknown) {
    return installation(address, { procedure: 'installation.connect', body });
  }

  it('installation connect rejects absent configuration and missing or wrong tokens', async () => {
    // Given an unconfigured installation and a configured installation.
    const open = await started();
    const hosted = await started(TOKEN);
    const body = { requestId: newKey(), fleetId: argo.fleetId, shipId, secret };

    // When a caller omits installation authority.
    expect((await handover(open.address, body)).status).toBe(404);
    for (const token of [undefined, 'wrong-token']) {
      const response = await fetch(`${hosted.address}/trpc/installation.connect`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-aeolus-installation-token': token }) }, body: JSON.stringify(body),
      });
      // Then the hand-over is unauthorized and registers nothing.
      expect(response.status).toBe(401);
    }
    expect(await fleetDatabase.lease.count({ where: { shipId } })).toBe(0);
  });

  it('installation connect accepts only the strict gateway envelope and a non-empty secret', async () => {
    // Given a served fleet.
    const { address } = await enabled();
    const body = { requestId: newKey(), fleetId: argo.fleetId, shipId, secret };

    // When malformed envelopes are submitted.
    for (const invalid of [{ ...body, extra: true }, { ...body, secret: '' }, { ...body, shipId: 'wrong' }, { ...body, fleetId: 'wrong' }, { ...body, requestId: '' }]) {
      // Then input is refused before registration.
      expect((await handover(address, invalid)).status).toBe(400);
    }
    expect(await fleetDatabase.lease.count({ where: { shipId } })).toBe(0);
  });

  it('installation connect saves only crew credentials and replays success after restart without registering again', async () => {
    // Given a served fleet and a stable request id.
    const { address } = await enabled();
    const body = { requestId: newKey(), fleetId: argo.fleetId, shipId, secret };

    // When the first hand-over succeeds and the process restarts.
    const first = await handover(address, body);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ result: { data: { enabled: true, connected: true } } });
    await apps.splice(0)[0]?.close();
    const restarted = await started(TOKEN);
    const replay = await handover(restarted.address, { ...body, secret: 'a-fresh-secret-is-not-request-identity' });

    // Then its durable receipt answers without a second lease or secret in storage.
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ result: { data: { enabled: true, connected: true } } });
    expect(await fleetDatabase.lease.count({ where: { shipId } })).toBe(1);
    const db = createPluginPrismaClient(pluginDatabaseUrl);
    try {
      const saved = await db.connection.findUniqueOrThrow({ where: { fleetId: argo.fleetId } });
      expect(saved.crewToken).toBeTruthy();
      expect(JSON.stringify([saved, await db.installationRequest.findMany()])).not.toContain(secret);
    } finally { await db.$disconnect(); }
  });

  it('installation connect checks off before replay and retains its connection across off/on', async () => {
    // Given a successful hand-over.
    const { address } = await enabled();
    const body = { requestId: newKey(), fleetId: argo.fleetId, shipId, secret };
    expect((await handover(address, body)).status).toBe(200);

    // When switched off, even an earlier successful request is forbidden.
    await installation(address, { procedure: 'installation.setEnabled', body: { requestId: newKey(), fleetId: argo.fleetId, enabled: false } });
    expect((await handover(address, body)).status).toBe(403);
    await expect(installation(address, { procedure: 'installation.get', body: { fleetId: argo.fleetId } }).then((response) => response.json())).resolves.toEqual({ result: { data: { enabled: false, connected: true } } });
    await installation(address, { procedure: 'installation.setEnabled', body: { requestId: newKey(), fleetId: argo.fleetId, enabled: true } });

    // Then switching on keeps the connection and permits receipt replay.
    expect((await handover(address, body)).status).toBe(200);
    expect(await fleetDatabase.lease.count({ where: { shipId } })).toBe(1);
  });

  it('installation connect rejects request ids used for another operation, fleet or ship', async () => {
    // Given a successful connect receipt and a served second fleet.
    const { address } = await enabled();
    const body = { requestId: newKey(), fleetId: argo.fleetId, shipId, secret };
    expect((await handover(address, body)).status).toBe(200);
    const other = unwrap(await useCases.createFleet({ requestId: newKey(), name: 'other', operatorEmail: 'other@example.com', hasViewer: false }));
    await installation(address, { procedure: 'installation.setEnabled', body: { requestId: newKey(), fleetId: other.fleetId, enabled: true } });

    // When another operation, fleet or ship uses that id.
    const collisions = [
      await installation(address, { procedure: 'installation.setEnabled', body: { requestId: body.requestId, fleetId: argo.fleetId, enabled: true } }),
      await installation(address, { procedure: 'installation.delete', body: { requestId: body.requestId, fleetId: argo.fleetId } }),
      await handover(address, { ...body, fleetId: other.fleetId }),
      await handover(address, { ...body, shipId: 'shp_01m3tbfspe96yf1rnr4ank9h1a' }),
    ];
    const switchId = newKey();
    await installation(address, { procedure: 'installation.setEnabled', body: { requestId: switchId, fleetId: argo.fleetId, enabled: true } });
    collisions.push(await handover(address, { ...body, requestId: switchId }));

    // Then all collisions retain the connection and answer REQUEST_ID_USED.
    for (const response of collisions) {
      expect(response.status).toBe(409);
      expect(await response.text()).toContain('used for another request');
    }
    expect(await fleetDatabase.lease.count({ where: { shipId, endedAt: null } })).toBe(1);
  });

  it('installation connect retries a refusal with the same id and a fresh secret, preserving already-connected conflict', async () => {
    // Given an unclaimed ship and a stable request id.
    const { address } = await enabled();
    const body = { requestId: newKey(), fleetId: argo.fleetId, shipId, secret };

    // When the secret is refused, then corrected using the same id.
    expect((await handover(address, { ...body, secret: 'refused' })).status).toBe(400);
    expect((await handover(address, body)).status).toBe(200);

    // Then the refusal has no receipt, and a new hand-over does not replace the connection.
    expect((await handover(address, { ...body, requestId: newKey() })).status).toBe(409);
    expect(await fleetDatabase.lease.count({ where: { shipId } })).toBe(1);
  });

  it('installation connect deregisters a ship from another fleet and keeps no connection', async () => {
    // Given a served target fleet different from the ship fleet.
    const { address } = await enabled();
    const other = unwrap(await useCases.createFleet({ requestId: newKey(), name: 'other', operatorEmail: 'other@example.com', hasViewer: false }));
    await installation(address, { procedure: 'installation.setEnabled', body: { requestId: newKey(), fleetId: other.fleetId, enabled: true } });

    // When this installation hands over the wrong fleet's ship.
    const response = await handover(address, { requestId: newKey(), fleetId: other.fleetId, shipId, secret });

    // Then it releases newly acquired crew and saves no target connection.
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('another fleet');
    expect(await fleetDatabase.lease.count({ where: { shipId, endedAt: null } })).toBe(0);
    await expect(installation(address, { procedure: 'installation.get', body: { fleetId: other.fleetId } }).then((answer) => answer.json())).resolves.toEqual({ result: { data: { enabled: true, connected: false } } });
  });

  it.each(['fleet:read', 'fleet:alert'])('installation connect deregisters a ship missing %s and keeps no connection', async (missing) => {
    // Given a ship missing one required scope.
    const { address } = await enabled();
    const deficient = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'deficient', type: 'watch-plugin', scopes: missing === 'fleet:read' ? ['fleet:alert'] : ['fleet:read'] }));

    // When the installation hands it over.
    const response = await handover(address, { requestId: newKey(), fleetId: argo.fleetId, shipId: deficient.shipId, secret: secretOf(deficient.secret) });

    // Then the acquired crew is released and no connection is saved.
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('fleet:read and fleet:alert');
    expect(await fleetDatabase.lease.count({ where: { shipId: deficient.shipId, endedAt: null } })).toBe(0);
    await expect(installation(address, { procedure: 'installation.get', body: { fleetId: argo.fleetId } }).then((answer) => answer.json())).resolves.toEqual({ result: { data: { enabled: true, connected: false } } });
  });

  it('concurrent installation hand-overs retain one connection', async () => {
    // Given two hand-overs of one commissioned ship.
    const { address } = await enabled();
    const body = { fleetId: argo.fleetId, shipId, secret };

    // When both requests race.
    const responses = await Promise.all([handover(address, { ...body, requestId: newKey() }), handover(address, { ...body, requestId: newKey() })]);

    // Then one succeeds and the retained connection has one live lease.
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.every((response) => [200, 400, 409].includes(response.status))).toBe(true);
    expect(await fleetDatabase.lease.count({ where: { shipId, endedAt: null } })).toBe(1);
    await expect(installation(address, { procedure: 'installation.get', body: { fleetId: argo.fleetId } }).then((answer) => answer.json())).resolves.toEqual({ result: { data: { enabled: true, connected: true } } });
  });

  it('installation delete after hand-over retains data while deregistration is unavailable, then deregisters before forgetting', async () => {
    // Given a successful installation hand-over.
    const { address } = await enabled();
    const body = { requestId: newKey(), fleetId: argo.fleetId, shipId, secret };
    expect((await handover(address, body)).status).toBe(200);
    const deleteBody = { requestId: newKey(), fleetId: argo.fleetId };
    // A fleet refusal at deregistration preserves the prerequisites for retry.
    isDeregisterUnavailable = true;

    // When deletion cannot deregister.
    expect((await installation(address, { procedure: 'installation.delete', body: deleteBody })).status).toBe(502);

    // Then the stored connection, switch and receipt remain.
    await expect(installation(address, { procedure: 'installation.get', body: { fleetId: argo.fleetId } }).then((answer) => answer.json())).resolves.toEqual({ result: { data: { enabled: true, connected: true } } });
    isDeregisterUnavailable = false;
    expect((await installation(address, { procedure: 'installation.delete', body: deleteBody })).status).toBe(200);
    expect(await fleetDatabase.lease.count({ where: { shipId, endedAt: null } })).toBe(0);
    await expect(installation(address, { procedure: 'installation.get', body: { fleetId: argo.fleetId } }).then((answer) => answer.json())).resolves.toEqual({ result: { data: { enabled: false, connected: false } } });
  });

  it('serves a fleet only once switched on: until then connect is refused', async () => {
    const { address } = await started(TOKEN);
    const fleetId = argo.fleetId;

    await expect(connectPlugin(address, { cookie, shipId, secret }).then((response) => response.status)).resolves.toBe(403);
    expect((await installation(address, { procedure: 'installation.setEnabled', body: { requestId: newKey(), fleetId, enabled: true } })).status).toBe(200);
    expect((await connectPlugin(address, { cookie, shipId, secret })).status).toBe(200);
    expect((await installation(address, { procedure: 'installation.setEnabled', body: { requestId: newKey(), fleetId, enabled: false } })).status).toBe(200);

    await expect(installation(address, { procedure: 'installation.get', body: { fleetId } }).then((response) => response.json())).resolves.toEqual({ result: { data: { enabled: false, connected: true } } });
  });

  it('deregisters its ship from the fleet before it forgets the fleet', async () => {
    const { address } = await started(TOKEN);
    const fleetId = argo.fleetId;
    await installation(address, { procedure: 'installation.setEnabled', body: { requestId: newKey(), fleetId, enabled: true } });
    expect((await connectPlugin(address, { cookie, shipId, secret })).status).toBe(200);

    expect((await installation(address, { procedure: 'installation.delete', body: { requestId: newKey(), fleetId } })).status).toBe(200);

    await expect(fleetDatabase.lease.count({ where: { shipId, endedAt: null } })).resolves.toBe(0);
  });

  it("forgets the fleet's connection and switch when the fleet is deleted", async () => {
    const { address } = await started(TOKEN);
    const fleetId = argo.fleetId;
    await installation(address, { procedure: 'installation.setEnabled', body: { requestId: newKey(), fleetId, enabled: true } });
    expect((await connectPlugin(address, { cookie, shipId, secret })).status).toBe(200);

    expect((await installation(address, { procedure: 'installation.delete', body: { requestId: newKey(), fleetId } })).status).toBe(200);

    await expect(installation(address, { procedure: 'installation.get', body: { fleetId } }).then((response) => response.json())).resolves.toEqual({ result: { data: { enabled: false, connected: false } } });
  });
});


describe('wake receiving against real core', () => {
  it('the app holds one wake stream when receiving is started twice', async () => {
    await connected();

    apps[0]?.startReceiving();
    apps[0]?.startReceiving();
    await expect.poll(() => asked.filter((path) => path === '/api/v1/ship/receive').length).toBe(1);

    expect(asked.filter((path) => path === '/api/v1/ship/wakeups')).toHaveLength(1);
  });

  it('the real open wake drains a backlog larger than one page', async () => {
    await connected();
    for (let index = 0; index < 21; index += 1) {
      unwrap(await useCases.sendMessage(argo, { selector: { kind: 'ship', shipId }, payload: `waiting ${index}`, idempotencyKey: newKey() }));
    }

    apps[0]?.startReceiving();

    await expect.poll(() => fleetDatabase.delivery.count({ where: { fleetId: argo.fleetId, recipientShipId: shipId, state: 'acknowledged' } })).toBe(21);
  });

  it('after restart the open wake acknowledges a delivery stored while stopped', async () => {
    await connected();
    apps[0]?.startReceiving();
    await expect.poll(() => completedReceives).toBe(1);
    await apps.splice(0)[0]?.close();
    const { messageId } = unwrap(await useCases.sendMessage(argo, { selector: { kind: 'ship', shipId }, payload: 'stored while stopped', idempotencyKey: newKey() }));

    const { app } = await started();
    app.startReceiving();

    await expect.poll(() => fleetDatabase.delivery.findFirstOrThrow({ where: { messageId } })).toMatchObject({ state: 'acknowledged' });
  });

  it('a new wake acknowledges a delivery after the open look completed', async () => {
    await connected();
    apps[0]?.startReceiving();
    await expect.poll(() => completedReceives).toBe(1);

    const { messageId } = unwrap(await useCases.sendMessage(argo, { selector: { kind: 'ship', shipId }, payload: 'a later wake', idempotencyKey: newKey() }));

    await expect.poll(() => fleetDatabase.delivery.findFirstOrThrow({ where: { messageId } })).toMatchObject({ state: 'acknowledged' });
  });

  it('an empty receive retains its core wait', async () => {
    await connected();
    const startedAt = Date.now();

    apps[0]?.startReceiving();
    await expect.poll(() => completedReceives).toBe(1);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(RECEIVE_WAIT_MS);
  });
});

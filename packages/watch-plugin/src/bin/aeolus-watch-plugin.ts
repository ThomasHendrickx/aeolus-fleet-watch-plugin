#!/usr/bin/env node
/**
 * `aeolus-watch-plugin start`: migrates the watch plugin's database,
 * connects again to every fleet with its kept crew token (a fleet without one
 * is not connected until its operator connects the watch plugin in the
 * console), then serves and receives as its ship in every fleet it serves,
 * until SIGINT or SIGTERM.
 * `aeolus-watch-plugin migrate`: migrates the database alone.
 */
import { requireCoreVersion } from '../adapters/fleet/core-version.js';
import { MigrationError, migrateDatabase } from '../adapters/prisma/migrate.js';
import { createWatchPluginApp } from '../app.js';
import { ConfigError, loadConfig, loadDatabaseUrl } from '../config.js';

const USAGE = 'Usage: aeolus-watch-plugin start | migrate';

async function start(): Promise<void> {
  const config = loadConfig(process.env);
  await requireCoreVersion(config.fleetUrl);
  await migrateDatabase(config.databaseUrl);
  const app = createWatchPluginApp({
    databaseUrl: config.databaseUrl,
    fleetUrl: config.fleetUrl,
    logger: { level: config.logLevel },
    ...(config.installationToken === undefined ? {} : { installationToken: config.installationToken }),
  });
  const restored = await app.restoreConnections();
  for (const { fleetId, ship } of restored) {
    app.server.log.info({ fleet: fleetId, ship }, "connected as the watch plugin's ship");
  }
  if (restored.length === 0) {
    app.server.log.warn('connected to no fleet: an operator connects the watch plugin in the console');
  }

  app.startReceiving();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
  await app.server.listen({ host: config.host, port: config.port });
}

try {
  switch (process.argv[2] ?? '') {
    case 'start':
      await start();
      break;
    case 'migrate':
      await migrateDatabase(loadDatabaseUrl(process.env));
      break;
    default:
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
  }
} catch (error) {
  if (error instanceof ConfigError || error instanceof MigrationError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}

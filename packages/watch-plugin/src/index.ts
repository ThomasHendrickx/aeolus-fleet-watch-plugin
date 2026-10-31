/** The watch plugin package's entry: its app, for whoever runs or tests it beside the fleet. */
export { createWatchPluginApp, type WatchPluginApp } from './app.js';
export type { WatchPluginRouter } from './adapters/trpc/router.js';

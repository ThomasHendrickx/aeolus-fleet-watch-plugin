# Timings and limits

Every fixed timing and limit of the watch plugin, with its constant and its reason. The default minutes per signal join this page with the slice that adds them.

| What | Value | Where | Why |
| --- | --- | --- | --- |
| Deliveries per receive | 10 | `RECEIVE_MAX` in `adapters/fleet/rest-fleet-door.ts` | The ship acts on none, so a small batch is enough |
| Pause before a receive is called again after the fleet did not answer | 1 second | `RETRY_MS` in `adapters/fleet/fleet-watch.ts` | Keeps a fleet that is down from being called in a loop |
| Rescan for a fleet newly connected or switched on | 5 seconds | `DEFAULT_RESCAN_MS` in `app.ts` | A connect or a switch starts receiving within seconds |
| Waits before a busy fleet's call is made again | common's `FLEET_BUSY_WAITS_MS` | `adapters/fleet/rest-fleet-door.ts` | The one schedule every client of the fleet follows |
| Installation token length | at least 32 characters | `INSTALLATION_TOKEN_MIN_LENGTH` in `config.ts` | As the fleet core takes it (decision 0020) |

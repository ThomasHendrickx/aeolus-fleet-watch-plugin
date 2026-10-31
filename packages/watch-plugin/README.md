# @aeolus-fleet/watch-plugin

Watches an Aeolus fleet: it compares core's facts with the defaults and the owner's expectations, raises alerts and tells the owner's ship (decisions 0071, 0072). Optional: Aeolus knows nothing about it beyond its ship, which holds `fleet:read` and `fleet:alert` and reaches the fleet only through its public API. Its ship receives while the process runs and acknowledges every delivery on receipt, acting on none; a ping from argo gets pong. Its architecture: [docs/watch-plugin.md](../../docs/watch-plugin.md).

## Running

1. Give it its own database and set its environment. No ship and no secret: the operator connects it.

| Variable | Required | What |
| --- | --- | --- |
| `DATABASE_URL` | yes | Its own Postgres database (`postgres://...`); it may share the Postgres server with the fleet and squadrons |
| `FLEET_URL` | yes | The fleet's public URL; it calls the ship API at `<FLEET_URL>/api/v1` and checks console sessions there. Not a secret; fixed here, so no caller can point it at another fleet |
| `HOST`, `PORT` | no | Where it listens; `127.0.0.1:4300` by default |
| `LOG_LEVEL` | no | `info` by default |
| `INSTALLATION_TOKEN` | no | The token a hosting service presents to its installation procedures, at least 32 characters (decision 0021). Unset: they do not exist and every fleet is served, as a self-hosted install needs |

2. `aeolus-watch-plugin start` migrates the database, connects again to every fleet whose kept crew token its fleet still takes, serves and receives as its ship. Any other fleet is not connected. `aeolus-watch-plugin migrate` migrates alone.
3. Each fleet's operator connects it: commission its ship with `fleet:read` and `fleet:alert`, and hand the ship's secret to `connection.connect`, server to server. It registers as a server and keeps only the crew token; the secret is never stored or logged.

## API

One tRPC router at `/trpc`, called with the console's session cookie, which the fleet checks through `console.session`. Every procedure but the installation's works on the session's fleet.

| Procedure | What |
| --- | --- |
| `connection.status` | Whether it serves the fleet and is connected, as which ship, and the ship it was last connected as |
| `connection.connect` | Connects with its ship's id and secret (`fleet:manage` session). Refused while connected (CONFLICT), for a ship of another fleet or without the two scopes (BAD_REQUEST) |
| `installation.setEnabled`, `get`, `delete` | With `x-aeolus-installation-token`: switches a fleet on or off, reads it, forgets it (decision 0021). Delete deregisters its ship from the fleet first; while the fleet does not answer it is refused (BAD_GATEWAY) and forgets nothing, so retry it with the same request id |

While it is off for the fleet, every procedure but `connection.status` answers FORBIDDEN.

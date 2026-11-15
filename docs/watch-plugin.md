# The watch plugin: architecture

`@aeolus-fleet/watch-plugin`: a long-running Node process, hosted beside squadrons, serving every fleet of the server with one connection each and switched per fleet as squadrons is (decisions [0021](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/decisions/0021-squadrons-installation.md), [0072](decisions/0072-watch-plugin-package.md)). It reaches each fleet only through the public API, as that fleet's watch plugin ship (`fleet:read`, `fleet:alert`). It compares core's facts with the defaults and the owner's expectations, raises alerts and tells the owner's ship, and never acts on a signal. Its own small database holds per fleet the connection (its ship and kept crew token), the switch and the installation's requests. It depends on `common` only.

What lives in core: the monitoring rule in decision [0071](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/decisions/0071-monitoring.md), the signals, alerts and expectations in the [monitoring design](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/design/monitoring/monitoring.md) (sections 4.4 to 4.7, 4.9 and 5), the product and its language in the [blueprint](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/blueprint.md), and the calls this package makes and the minimum core version it checks in [docs/compatibility.md](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/compatibility.md).

## Layers

| Layer | Pieces |
| --- | --- |
| Core (pure) | **Signals**, **alerts**, **pass**: one pass of one fleet reads the facts and the open alerts, runs every signal, raises and tells what parted with no alert open, and clears what moved back (the next slices; the design's section 5 has the flow). **Inbox**: acknowledge every delivery to its ship, a ping with pong. **Connection**, **installation** and **operator**, as the trierarch plugin's, a delete deregistering first. **Shared**: the Clock port, typed errors, Result |
| Ports | **FleetDoor**: the ship calls it makes as its ship (register, whoami, fleet.ship, receive, ack, pong, deregister). **ConnectionStore**, **FleetSwitches**, **InstallationRequests**, **ConsoleSessions**, **Clock** |
| Adapters | REST to the fleet; tRPC for the web app's server (`connection`, `installation`); Prisma on its own database (`connections`, `fleet_switches`, `installation_requests`); one wake stream per fleet it serves and is connected to |

## Receiving

Each connected, served fleet has one authenticated REST stream at `GET /api/v1/ship/wakeups`, read as bytes arrive. Core 0.39.0 or later is required. An open wake, a later wake and the five minute safety timer trigger `receive`. Looks are serialized within a fleet; a wake during a look queues one more. A full page triggers another receive until a short page is returned. Fleets proceed independently. The ship acknowledges deliveries, answers pings with pong and acts on none.

A wake resets the safety timer. Closed or silent streams and refused openings, including `FLEET_BUSY`, reopen after the spread backoff. A stream's `LEASE_ENDED` event or opening refusal stops it and drops its connection. Rescans stop streams for fleets switched off, disconnected or using a replacement crew token. Shutdown aborts all streams and receives and waits for active acknowledgements before closing the database. Receive waits in core for a delivery, as core's receive does, and every core call made while the fleet is busy is made again after common's `FLEET_BUSY_WAITS_MS`.

## Configuration

Each setting by name, its default and what a fleet's own value overrides: [packages/watch-plugin/README.md](../packages/watch-plugin/README.md). The timings and limits: [timings-and-limits.md](timings-and-limits.md).

## Deployment

A long-running Node process beside squadrons, with a small Postgres database of its own (it may share squadrons' Postgres server, in its own schema), on any VM or container host next to the server. It needs no public address: only the web app's server and the fleet's API talk to it or it to them.

# 0072 The watch plugin package: raise first, then tell

- `@aeolus-fleet/watch-plugin` carries the watch of [decision 0071](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/decisions/0071-monitoring.md): optional, its own package and process beside squadrons, a ship of each fleet it serves (kind plugin, owned by argo, `fleet:read` and `fleet:alert`), connected as squadrons and the trierarch plugin are (0017, 0030: the console commissions its ship and hands the secret over, server to server) and switched per fleet as squadrons is (0021). Aeolus knows nothing about it beyond its ship. 0071 stays in aeolus-fleet as the monitoring rule; this decision holds only what is this package's.
- Its own small database holds per fleet the connection, the switch and the installation's requests. Alerts and expectations live in core, so nothing is kept per alert.
- Each pass of a fleet reads core's facts and the open alerts, compares them with the defaults and the owner's expectations, raises an alert for each occurrence that parted with none open, then sends it to its recipients with the alert id as the idempotency key, and clears an open alert whose fact moved back. Clearing sends nothing. A refused raise or send is retried by the next pass.
- It never acts on a signal (0016, 0071). Its ship receives as long as its process runs and acknowledges every delivery on receipt, acting on none.
- A delete deregisters its ship from the fleet first. While the fleet does not answer, the delete is refused (BAD_GATEWAY) and forgets nothing, so the hosting service retries it.

Why: the comparing and telling is a plugin's job, not core's; core keeps the facts and the alerts, the plugin holds nothing it could not read again, and a pass that reads afresh needs no queue.

Rejected: a table of alerts in the plugin (core holds them); a retry queue for refused sends (the next pass retries); the plugin acting on a signal (0016).

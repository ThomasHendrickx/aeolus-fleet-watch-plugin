# Decisions

Current state only; history is in git. To change a decision, edit its file and its line here in the same commit. Decisions keep one numbering across the trains' repositories; the full index is aeolus-fleet's [docs/decisions/README.md](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/decisions/README.md).

- [0072](0072-watch-plugin-package.md) **Watch plugin package.** Optional, its own package and process beside squadrons, a ship of each fleet (owned by argo, fleet:read and fleet:alert), connected and switched per fleet as the trierarch plugin is; its own small database holds the connection, the switch and the installation's requests, nothing per alert; each pass reads core's facts, raises first, then sends with the alert id as key, and sends nothing on clear; its ship acknowledges every delivery and acts on none.

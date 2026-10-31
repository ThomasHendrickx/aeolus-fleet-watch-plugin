# Aeolus watch plugin

`@aeolus-fleet/watch-plugin` watches an [Aeolus](https://github.com/ThomasHendrickx/aeolus-fleet) fleet: it compares core's facts with the defaults and the owner's expectations, raises alerts and tells the owner's ship. It is optional: a ship of each fleet it serves, beside core, reaching the fleet only through its public API. How to run it and its API: [packages/watch-plugin/README.md](packages/watch-plugin/README.md). Its architecture: [docs/watch-plugin.md](docs/watch-plugin.md). For the product, see [aeolus-fleet](https://github.com/ThomasHendrickx/aeolus-fleet).

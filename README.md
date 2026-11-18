# Aeolus watch plugin

`@aeolus-fleet/watch-plugin` watches an [Aeolus](https://github.com/ThomasHendrickx/aeolus-fleet) fleet: it compares core's facts with the defaults and the owner's expectations, raises alerts and tells the owner's ship. It is optional: a ship of each fleet it serves, beside core, reaching the fleet only through its public API. How to run it and its API: [packages/watch-plugin/README.md](packages/watch-plugin/README.md). Its architecture: [docs/watch-plugin.md](docs/watch-plugin.md). For the product, see [aeolus-fleet](https://github.com/ThomasHendrickx/aeolus-fleet).

## Release

Dispatch Candidate on the release commit with the version. It builds and uploads the package tarball and its integrity manifest. Walk that candidate on staging and record the `staging-walk` commit status as `<version>: passed, candidate run <id>`.

Dispatch Release on the same commit with the version and candidate run ID. It requires a passed walk for that version and run, verifies the successful Candidate run, commit, package version and tarball integrity, then publishes the downloaded tarball. It refuses a release without a matching walked candidate.

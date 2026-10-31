---
name: aeolus-fleet-watch-plugin
description: Mandatory with behaviour-driven-development for every code change in this repository. Layout, the fleet door, testing and what lint and CI enforce.
---

# The watch plugin

Load with `software-development` and `behaviour-driven-development`; with `domain-modelling` for `src/core` and `src/adapters`; with `typescript` for every `.ts`; with `performance` where a pass reads data.

Layout (`packages/watch-plugin/src`):
- `core/{connection,inbox,installation,operator,shared}`, and `core/{signals,alerts,pass}` as the slices add them: pure domain, use cases and ports. A use case is a file in `core` that exports a factory named `create<Name>` (like `createConnect`).
- `adapters/{fleet,prisma,trpc,http,crypto}`, wired in `app.ts`; the command in `bin/`; environment in `config.ts`.
- `testing/`: what other trains test against, published as `@aeolus-fleet/watch-plugin/testing`.

The fleet door:
- Core only over `/api/v1`, through `adapters/fleet`, with `@aeolus-fleet/common` for the shapes. Only the calls aeolus-fleet's `docs/compatibility.md` lists for the watch plugin.
- A call core added later raises `MINIMUM_CORE_VERSION` (`adapters/fleet/core-version.ts`) in the same PR.
- The alert message's shape comes from common's `schemas/alert.ts` only.

Testing (decision 0014):
- Tests come from the approved scenarios and the guarantees: a restart sends nothing twice, two passes at once give one alert and one message, a flap gives one alert per occurrence.
- Unit: beside the file, with hand-written in-memory fakes of the ports (`test/support`); assert outcomes and stored state.
- Integration: `test/*.integration.test.ts`, against a real core in process through `@aeolus-fleet/core/testing`, on Testcontainers Postgres from core's global setup.

Enforced by lint/CI (`eslint.config.js`, `scripts/`): a `feat` or `fix` commit touching `src` comes right after a `(red)` commit with only tests (every other commit type passes), a test beside every use case, every test in a Vitest project, npm only, no em dash; in `src/core` no Prisma, pg, Fastify, tRPC, adapter or `@aeolus-fleet/core` import, no clock, crypto, `Math.random` or `throw`; Prisma only in `adapters/prisma`; no `vi.mock` anywhere, no `vi.fn` or `vi.spyOn` in `src/core`; casts, exhaustive switches, parameter count, boolean names, default exports, file names.

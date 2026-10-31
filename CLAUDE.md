# Aeolus watch plugin: guidelines for Claude Code

## What it is

`@aeolus-fleet/watch-plugin`: a ship of each Aeolus fleet it serves, beside core, owned by argo. It compares core's facts with the defaults and the owner's expectations, raises alerts and tells the owner's ship; it never acts on a signal (decisions 0016, 0071). Aeolus's promises: aeolus-fleet's [blueprint](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/blueprint.md).

## Source of truth

- docs/watch-plugin.md: this package's architecture. docs/timings-and-limits.md: every fixed timing and limit.
- docs/decisions/: this repository's decisions; the full index is aeolus-fleet's [docs/decisions/README.md](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/decisions/README.md). Do not reopen a recorded decision; raise it as a question instead.
- aeolus-fleet's [blueprint](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/blueprint.md): product, language, behaviour.
- aeolus-fleet's [docs/compatibility.md](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/compatibility.md): what this package may call in core.
- aeolus-fleet's [monitoring design](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/design/monitoring/monitoring.md) and decision 0071: the signals, the alerts and what the watch does with them.

If the docs do not answer a behaviour question, stop and ask. Never decide product behaviour yourself.

## House rules

- npm only (npm install, npm run, npm test). Never pnpm or yarn.
- English for all code, names, comments, commits, paths and database fields.
- No em dashes anywhere: code, docs, commits, PR text.
- Use the ubiquitous language from the blueprint (ship, type, crew, lease, commission, release, retire, delivery). Invent no synonyms or new terms: name the concrete parts, and split a block that covers two things.

## Architecture rules

- Ports and adapters. `packages/watch-plugin/src/core` holds domain, use cases and ports, with no framework, Prisma, pg, tRPC or core imports. The lint rule enforces it; never disable it.
- Prisma lives in `src/adapters/prisma` only.
- Core only through `/api/v1` and `@aeolus-fleet/common`: the calls listed for the watch plugin in aeolus-fleet's [docs/compatibility.md](https://github.com/ThomasHendrickx/aeolus-fleet/blob/main/docs/compatibility.md).
- Every table has fleet_id. Every query is scoped by it.
- The alert message's shape comes only from common's `schemas/alert.ts`; never copy it.
- Never act on a signal (decisions 0016, 0071): raise, tell, clear.
- `MINIMUM_CORE_VERSION` is raised in the same PR that needs a newer core.

## Skills

Load the matching skills from `.claude/skills/` (Codex: `.agents/skills/`) before the work they name. They are mandatory, not suggestions:

- `software-development`: every code change.
- `behaviour-driven-development` and `aeolus-fleet-watch-plugin`: every code change. Tests from approved scenarios and the guarantees, red, green, refactor per scenario (decision 0014).
- `domain-modelling`: anything under `src/core` or `src/adapters`.
- `typescript`: every `.ts` change.
- `performance`: designing or building a query, a list or a pass that reads data.
- `code-review`: reviewing a branch, pull request or diff.
- `pull-request`: writing a pull request body.
- `writing-for-agents`: editing CLAUDE.md, a skill, or a doc agents read.

`aeolus-fleet-watch-plugin` lives here. The others come from ThomasHendrickx/skills, pinned in `skills-lock.json`: never edit them here; change them there, tag a release, then `npx skills@1.7.2 add ThomasHendrickx/skills#<tag> --agent claude-code codex -y`.

## Quality

- npm run typecheck, npm run lint and npm test green before every commit, except a test-driven red commit that only adds the failing test and is labelled `(red)`. Push only a green head. Zero lint errors, no eslint-disable without a comment explaining why.
- Every use case has unit tests with in-memory ports. Every adapter that touches Postgres has a Testcontainers test.
- Delivery guarantees are proven by tests: concurrency, rollback, restart. A guarantee without a test does not exist.
- Report a test as passing only after you saw it run by name.
- No any without a comment explaining why.

## Working

Do what the prompt and the docs ask, nothing more: done means the acceptance criteria are met, and earlier slices are not precedent.

- One slice per session, one PR per slice, kept thin. Commit per logical step, not one catch-up commit.
- A finding that does not block the criteria is not acted on: a real defect is filed as an issue, anything else goes in the PR.
- New core fleet functionality is built only from a design Thomas approved. A design goes purpose first, then the lessons to check against, then questions, with no detailed decisions before the purpose is agreed. A backbone design has a full flow diagram, happy and unhappy paths. Foundational work goes structure first, approved, then one part at a time.
- Repo text must serve the current commit. What git shows (what changed, the steps taken) lives in commits and the PR, never in files. Decisions go into the docs or an ADR as current state.
- New rules, checks, exceptions or process steps come only from Thomas: propose, never add.
- No self-review passes. The one review is a clean-room session after the PR.

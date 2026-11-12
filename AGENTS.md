# SuperExchange

The suite's communication server, a Matrix Application Service. The charter decisions that set
its scope are `decisions/2026-11-10-superexchange-owns-the-communication-server.md` and
`decisions/2026-11-11-superexchange-takes-gates-from-the-event-relay.md`.

## Rules

- **It carries the board-room events; treaty defines them.** Build and read Matrix content only
  through `@superjackfruitlabs/treaty-matrix-events`. A new shape is a treaty change first.
- **Nothing requires it.** No change here may make SuperPipeline, SuperMessage or AgentPod need
  this service to work.
- **The layers hold.** `apps/exchange/test/architecture.test.ts`: config < store < appservice <
  board-chat < routes < main. An import stays in its layer or points down. No runtime import
  cycle, and no file under `src/` over 1,000 lines.
- **The ratchets only tighten.** Lint counts per rule (`scripts/lint-baseline.json`) may fall,
  never rise; lock a fall in with `bun run lint --update`. Never raise a baseline, an
  `OVERSIZE` entry or `LARGEST_CYCLE` to get a change through: fix the code.
  `docs/code-quality.md` says what each check holds.
- **A setting's value never reaches a log, an error or a response.**
- **Every guard has a test that fails when the guard is reverted.**

## Layout

- `apps/exchange/`: the service. `src/store` is its SQLite store (`migrations.ts`, `model.ts`
  with the `Store` interface, one module per table group, composed by `index.ts`),
  `src/appservice` the Matrix transport, `src/board-chat` the board work in chat, `src/routes`
  the HTTP surface (relay deliveries, the operator's board API).
- `deploy/staging/`: the staging deploy, run on the staging host by its forced-command key.
- `deploy/production/`: the production deploy, run on the production host by its forced-command
  key from a `v*` tag (`release.yml`).

## Checks

`bun run check` runs what CI runs: format, typecheck, lint (the type-aware ratchet in
`scripts/lint.mjs`), tests. Run it before pushing, after `bun install --frozen-lockfile`.

A change to what the store does changes `apps/exchange/test/fixtures/store-trace.json`;
regenerate it with `STORE_TRACE_WRITE=1` only when that change is the point, and say why.

## Hosting

Forge is primary and push-mirrors to GitHub. Open pull requests on forge only. CI and review run
on forge (`.forgejo/workflows`). Deploy jobs go in `.github/workflows` and run only on GitHub,
guarded with `if: github.server_url == 'https://github.com'`.

Never commit secrets or keys.

## Releases

Versions start at 0.0.1, and only the operator pushes tags. A `v*` tag on main deploys
production (`deploy/production/release.sh`, rolling back on failure) through the shared release
workflow; `.github/release-config.json` holds its settings. `CHANGELOG.md` keeps an
`## Unreleased` section: add an entry with each change people will notice. Before a tag, a
release-prep PR runs `sh .github/release/prep-release.sh vX.Y.Z`.

## Shared kit

`.forgejo/workflows/claude-review.yml`, the `claude-triage` job in `ci.yml`, and
`.github/claude/claude-ci.mjs` are copies of the shared claude-ci kit. Change the master and
sync; never edit a copy.

`.github/workflows/release.yml` and `.github/release/` are copies of the shared release kit
(estate `release/`). Change the master and sync; never edit a copy.

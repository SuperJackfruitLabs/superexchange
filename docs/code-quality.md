# Code quality ratchets

> **Checked.** Every number below is held by a script or a test that fails when it is wrong.
> This page explains them; the numbers themselves live in the files it cites.

Each check records how the code looks and fails if it gets worse. Each one also fails if it gets
**better** without the record being lowered, so a stale record cannot let the next regression
through. `bun run check` runs all of them, and CI's `check` job runs the same steps.

## Lint: `bun run lint`

[oxlint](https://oxc.rs) `1.88.0` with `oxlint-tsgolint` `7.0.2004`, both pinned exactly in the
root `package.json`. tsgolint type-checks with its own TypeScript-Go, so it does not depend on
the repo's TypeScript. Configuration: [`.oxlintrc.json`](../.oxlintrc.json). Script:
[`scripts/lint.mjs`](../scripts/lint.mjs).

- **Covers** `apps/`, `deploy/` and `scripts/`.
- **Rules:** the `correctness` and `suspicious` categories, plus floating and misused promises,
  `await` of a non-promise, exhaustive `switch` (a `default` counts), type-only imports, no
  `any`, no `!` non-null assertion, no empty block (an empty `catch` included), unused code, and
  no `console` outside tests and scripts.
- **The ratchet.** Findings are counted per rule in
  [`scripts/lint-baseline.json`](../scripts/lint-baseline.json), in two parts: `src` (shipped
  source: under a `src/` folder and not a test file) and `rest` (tests, deploy and scripts). A
  count may fall but never rise. A rule missing from a part must be clean there, so a rule at
  zero in shipped source stays at zero whatever the tests allow.
- **After a cleanup,** `bun run lint --update` writes the lower counts; it refuses to raise one.
  Lint fails until you do, and a rule that reaches zero leaves the baseline for good.
- **Before running it:** `bun install --frozen-lockfile`. Without the dependencies the typed
  rules cannot load the project and report `typescript(tsconfig-error)`, which the baseline does
  not allow.

What the baseline holds, and why it is held rather than cleared:

- `no-unsafe-type-assertion` is most of it: an `as` from `unknown` or a wider type, mostly where
  a relay body or a Matrix event has already been checked by treaty's guards. Rewriting them
  wholesale risks changing behaviour. Lower them in code you touch.
- `no-console` (11, shipped): `main.ts`, the transaction handler and the routes write their log
  lines to stdout on purpose; there is no logger to route them through.
- `unicorn(consistent-function-scoping)`, `no-shadow`, `consistent-return`, `unbound-method`
  (in `main.ts`'s wiring) and `no-misused-promises` (`main.ts`'s signal handlers) are each a
  handful in shipped source. Each fix moves or rewrites code near a behaviour, so they wait for
  a change that touches it.

## Architecture: `apps/exchange/test/architecture.test.ts`

Run by `bun test`. It holds:

- **the layers**, lowest first: `config` < `store` < `appservice` < `board-chat` < `routes` <
  `main`. A file belongs to the layer named by its first path segment under `src/`. An import
  stays in its layer or points down; a new top-level folder fails until it is placed in the
  list. The order is read from the code: every layer imports the one just below it, except
  `store`, which knows no settings and sits beside `config` (`UNJOINED_NEIGHBOURS`). Swapping
  two layers fails.
- **no runtime import cycle** under `src/` (`LARGEST_CYCLE`, 0). An edge is a static import or
  re-export that brings in a value, a bare `import "./x.ts"`, or a dynamic `import()`. A
  type-only import is erased before the code runs and is not an edge.
- **files of 1,000 lines or fewer** under `src/` (`SIZE_LIMIT`). A file over it must have an
  `OVERSIZE` entry holding its current size, and the entry fails when the file grows and when it
  shrinks without the entry being lowered. `OVERSIZE` is empty.

Each rule also has a test against inputs it must refuse, so it cannot pass by checking nothing.

When a lower layer needs something from a higher one, or two files need each other:

- **a pure helper, type or constant moves down** to where both can reach it
  (`board-chat/gate-offer.ts` holds `gateOffer` and `gateTxnId`, which `gate-card`,
  `gate-receipt` and `escalation-repost` once took from each other);
- **a genuine upward call becomes a narrow interface** declared in the lower layer and passed in
  where the pieces are put together (`main.ts`). No service locators and no global registries.

## The store

`src/store/` is one SQLite database behind one `Store` interface. `model.ts` holds the shapes,
the interface and `StoreError`; `migrations.ts` the schema; each table group (boards, rooms,
gates, questions, follow-ups, attention, notices, checks, crypto) is a module whose
`<group>Queries(db, stamp)` returns its part of the `Store`. `index.ts` opens the database,
migrates, and composes them. Callers import `../store/index.ts` only.

[`test/store-trace.test.ts`](../apps/exchange/test/store-trace.test.ts) characterizes the whole
store: one scripted run through every method on a fixed clock, compared with
`test/fixtures/store-trace.json` (every result, every row left in every table, the schema, a
digest of the migrations, the method list). A new method fails until the script calls it.
Regenerate the fixture only for a change meant to alter what the store does, with
`STORE_TRACE_WRITE=1 bun test apps/exchange/test/store-trace.test.ts`, and say why in the
commit.

## Numbers when the ratchets went in (2026-11-13)

Before, lint was plain `oxlint --deny-warnings` with the default rules and passed with no
findings; the counts below are the type-aware rules above, run on the code as it was.

|                                                       | Before                        | After                                |
| ----------------------------------------------------- | ----------------------------- | ------------------------------------ |
| Lint findings (type-aware), shipped source            | 103, 10 rules                 | 86, 8 rules                          |
| Lint findings (type-aware), tests, deploy and scripts | 213, 9 rules                  | 203, 8 rules                         |
| Largest runtime import cycle                          | 3 files                       | none                                 |
| Largest file under `src/`                             | `store/index.ts`, 2,317 lines | `board-chat/gate-card.ts`, 799 lines |
| Tests                                                 | 428                           | 435                                  |

# Changelog

Each release deploys SuperExchange to production. The host builds the tag's image, checks it,
and puts the release before it back when the checks fail.

## Unreleased

- Releases run on the suite's shared release workflow: the tag gate reads forge CI's result for
  the tag's commit, and every tag gets release notes on GitHub.

## v0.0.2 — 2026-11-12

- First release in production: everything listed under v0.0.1.
- The release checks that the tag is on main without fetching again, which a private repository
  refused.

## v0.0.1 — 2026-11-12

Never deployed: the release stopped at its tag check (fixed in v0.0.2).

- SuperExchange, the Matrix application service for SuperPipeline's board rooms: an operator opts
  a board in, and its gates, questions, approval requests, delivery follow-ups and waiting cards
  are posted to the board's room once, from the event relay.
- A person answers in the room, and the answer acts at SuperPipeline as that person, with one
  receipt. Reminders, escalations, quorum progress, held approvals, checks, pull-backs and
  overrides are said once, in reply to their card.
- A periodic sweep settles gates decided elsewhere and posts what the relay missed
  (`SUPEREXCHANGE_SWEEP_SECONDS`).
- Board rooms are end-to-end encrypted. Plaintext rooms are a staging-only switch.
- A person whose Matrix account is linked to nobody is told how to link it, at most once a day
  per room.
- The store is SQLite with versioned migrations; a production release snapshots it first and
  restores it on a rollback that crosses a migration.

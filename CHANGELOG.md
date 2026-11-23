# Changelog

Each release deploys SuperExchange to production. The host builds the tag's image, checks it,
and puts the release before it back when the checks fail.

## Unreleased

- A gate cancelled on the board (its card moved by hand or archived while the review was pending)
  now closes its card in chat. The sweep reads the gate as `cancelled` and posts treaty's
  `cancelled` receipt, naming nobody, once; a cancelled gate not yet posted is never posted.
  Before, the card stayed open and answerable. Needs treaty v0.0.18.

## v0.0.5 — 2026-11-23

- Relay deliveries follow the suite's receiver status contract. A reminder, an escalation or a
  quorum, release or pull-back notice for a gate or question that has arrived but is not yet
  posted is answered 503, so the relay sends it again instead of losing it; a delivery the
  service could not handle just now (its store failed) is 503 too, rather than an unhandled 500.
- A principal id is asked about only when it is in treaty's grammar (`prn_` and 20 hex digits);
  a looser id names nobody and reaches neither the organization plane nor an invite.
- No change in behaviour: `treaty.json` declares what SuperExchange produces and consumes, and CI
  runs `treaty verify` against it. Tests hold every request the SuperPipeline and Accounts clients
  send to treaty's `decisions.v1` and `plane.v1` contracts, and run the plane's refusals through
  the Accounts client.
- Treaty 0.0.17.

## v0.0.4 — 2026-11-16

- Gate messages in board rooms now list the opening run's linked artifacts, preserving pinned
  SuperLibrary version links; gates with no linked artifact say so explicitly.

## v0.0.3 — 2026-11-13

- A waiting card raised an hour or more before it is posted says when it was raised and how long
  before the post that was, at the head of its summary ("Raised 6 Nov, 06:32 UTC, 7 days before
  this card was posted; what it says is as of then."), in the prose and in the card's summary
  field. A card re-posted for an escalation says it as of that post.
- A waiting card's receipt line is a reply to the card it settles, so any client shows which card
  it closed. The structured outcome at the card is unchanged.
- No change in behaviour. Lint is type-aware (oxlint with oxlint-tsgolint) and held by a
  per-rule ratchet; the architecture test also refuses runtime import cycles and files over
  1,000 lines; the store is split into a migrations list, a model and one module per table
  group, behind the same `Store` interface. `docs/code-quality.md` describes the checks.
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

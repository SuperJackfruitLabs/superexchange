---
title: The sweeps
description: How SuperExchange asks every enabled board what it still waits on, so a card the relay missed is posted and a card settled elsewhere is settled in chat. The interval, the backoff and what a failed read does.
---

The relay is the fast path, not the only one. Beneath it, SuperExchange asks each enabled board,
one at a time, what it is still waiting on: once at boot, then every `SUPEREXCHANGE_SWEEP_SECONDS`
(whole seconds from 15 to 86400; 60 when unset).

There are four sweeps, each with its own backoff:

| Sweep | Reads (with SuperExchange's own token) | Needs |
| --- | --- | --- |
| Gates | `GET /v1/boards/:boardId/gates/pending`, and `GET /v1/boards/:boardId/gates/:gateId` for one that left the list | `gates:read` |
| Questions | `GET /v1/boards/:boardId/elicitations/pending` | `approval-requests:relay` |
| Follow-ups | `GET /v1/boards/:boardId/deliveries/pending` | `gates:read`, SuperPipeline v0.0.30 or later |
| Waiting cards | `GET /v1/boards/:boardId/attention/pending` | `gates:read`, SuperPipeline v0.0.30 or later |

## The token

The sweeps read with SuperExchange's own token, not a person's: Accounts issues it
(`POST /api/token/service`, audience `SUPERPIPELINE_URL`) and SuperExchange holds it until shortly
before it expires. The scopes come from SuperExchange's service credential at Accounts.

## The gate sweep

- **A gate the relay never delivered** (it missed one, or gave up) is recorded as if it had been
  delivered and posted like any other. A delivered gate not yet posted is offered again; offering
  twice is harmless, since the post is claimed once.
- **A gate decided elsewhere** (on the web, in `supi`, by another path) is settled: when the board
  reads it as resolved with a decision, the receipt an answer in chat would have posted is posted
  once, encrypted in an encrypted room. The sweep and the answer path share one claim, so a gate
  answered in chat and then seen resolved has one receipt; a later answer in chat is told it was
  already decided.
- **A gate decided before it was ever posted** is never posted.
- **Absence is not a decision.** A gate missing from the pending list that the board does not read
  as resolved with a decision is left as it is.

## The other three

- **Questions:** a question the relay missed is posted; a question the board no longer lists
  (answered on the board, or retired by the agent's next question) is closed with one line, or
  never posted.
- **Follow-ups and waiting cards:** one the relay missed is posted; one the board no longer lists
  is settled with one receipt naming nobody ("settled on the board"), or never posted.

## When a board cannot be read

A board that cannot be read settles nothing and closes nothing. That covers 404 for a board outside
SuperExchange's workspace, 403 without the scope, a refused or missing token, and the board or
Accounts being down. It is logged, and the boards after it are still asked.

A pass in which **every** board failed waits twice as long before the next, up to eight times the
interval. A pass that read any board goes back to the interval. Passes never overlap.

## Retries that ride on the same interval

Every `SUPEREXCHANGE_SWEEP_SECONDS`, notices that were kept but not yet said are tried again too.
Reminders and escalations are not swept from the board: they arrive from the relay only, so a
notice the relay never delivered is never said.

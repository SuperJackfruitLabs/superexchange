---
title: Notices, pull-backs, overrides
description: What the board says about work already in its room (reminders, escalations, quorum progress, held approvals, checks), and the pull-backs and check overrides a person can send from chat.
---

## Board-room notices

What the board says about work already in a room arrives from the relay as seven CloudEvents types,
each `com.superjackfruit.superpipeline.<event>.v1`. Each is checked with treaty's predicate and its
`event`, kept for opted-in, enabled boards, recorded once, and said once as a reply to the card it
concerns. Every message is built by treaty.

| Event | What the room sees |
| --- | --- |
| `decision.reminded` | treaty's notice in reply to the waiting card (a gate, question, follow-up or waiting card). Overdue checks have no card: their reminder stands alone. |
| `decision.escalated` | The workspace's owners and admins are invited, then the notice in reply to the card. See below. |
| `gate.approval_recorded` | A quorum gate's progress ("Approved by Ana — 1 of 2. Waiting for 1 more.") in reply to the gate, and `dev.agentpod.gate.progress.v2`. The count is recorded on the gate and never walked back. |
| `decision.released` | In reply to the gate, settled or not (it follows a held approval's receipt), and `dev.agentpod.decision.released.v2`. |
| `decision.pulled_back` | In reply to the gate, and `dev.agentpod.decision.pulled_back.v2`. |
| `check.failed` | A line in the room, in reply to the open checks.waiting card for that card and stage when there is one, and `dev.agentpod.check.failed.v2`. A failure that sent the card back closes that card. |
| `check.overridden` | The same, with `dev.agentpod.check.overridden.v2`. |

A notice about a card SuperExchange never posted, or one already settled (for a reminder, an
escalation or progress), is answered `ignored` and never said. Who did something is named by
Accounts' label for them, never by an id.

Each send is under a transaction id derived from the notice. One that fails keeps its claim and is
sent again at boot, when a person joins, and every `SUPEREXCHANGE_SWEEP_SECONDS`.

## Escalations

An escalation invites the workspace's **owners and admins who have a linked Matrix id** into the
room, each once per board. One who leaves is not invited back; an invite the homeserver refuses is
tried again at the next escalation. Accounts lists SuperExchange's own workspace
(`GET /api/principals?kind=human`, then `GET /api/principals/:id/identities?system=matrix`), so a
board whose `orgId` is another workspace escalates to nobody. A Matrix id is never guessed: an
admin who linked none is not invited.

**Overdue checks** escalate with a `dev.agentpod.checks.waiting.v2` card listing them, read from
`GET /v1/boards/:boardId/cards/:cardId/checks`; the notice replies to it. A board that refuses that
read (SuperPipeline before v0.0.30) gets the notice alone, and the read is not retried.

**When an invited admin joins**, each still-open escalated card is posted again below, from a
fresh read of the board, so the admin can read it: a card sent before they were invited was not encrypted for them. Its record
moves to the new copy only if the board still offers what was recorded. The old copy is told
"Moved below, so the workspace admins who just joined can read it. Answer the copy below; this one
no longer counts.", and an answer to it then acts on nothing. The notice is posted again in reply
to the new copy. A board that cannot be read gets the notice alone.

## Pull-backs and overrides from chat

Two things a person can send from the room:

| Sent in chat | References | Carried to SuperPipeline as |
| --- | --- | --- |
| `dev.superpipeline.gate.pull_back.v2` | A gate posted here, in its room | `POST /v1/boards/:boardId/gates/:gateId/pull-back` `{ comment }` |
| `dev.superpipeline.check.override.v2` | A checks.waiting card posted here (its room, board and card) | `POST /v1/boards/:boardId/cards/:cardId/checks/:name/override` `{ comment }` |

Each is carried as the person who sent it, with Accounts' assertion. Only a person; a comment is
required, within 8192 bytes, and its absence is said in the room ("Pulling back an approval needs a
comment saying why. Nothing has changed."). The board's refusal is said in the room.

Success says nothing by itself: the board's `decision.pulled_back` or `check.overridden` notice
does.

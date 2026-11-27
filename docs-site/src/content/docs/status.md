---
title: Status and limits
description: Where SuperExchange stands. v0.0.6 in production, carrying production boards, what works today, and the gaps other products still owe it.
---

SuperExchange is early. **v0.0.6** is the current production release (2026-11-24); v0.0.2 was the
first release in production. Production boards are opted in and carried by SuperExchange; a board
is moved one at a time, by listing it in AgentPod's `BOARD_CHAT_MOVED_BOARDS` and then opting it in
here. A board that has not moved is spoken for, if at all, by AgentPod's hub, as before.
Nothing on this page is a plan; it is what the current code does and does not do.

## What works

The useful path is already complete: we can make the room, carry each supported card, bring a
person's answer back, and reconcile work that took another route.

- Board rooms made once, end-to-end encrypted, with the board's people invited.
- Gates, questions and approval requests, delivery follow-ups and waiting cards, each posted
  exactly once after a person has joined, and answered from the room as that person.
- Reminders, escalations, quorum progress, released and pulled-back approvals, failed and
  overridden checks, said once in reply to their card.
- Gate messages list the opening run's linked artifacts, keeping pinned SuperLibrary version
  links, and say so when there are none.
- Pull-backs and check overrides sent from chat.
- A relay delivery that cannot be handled yet (a notice for a card that has arrived but is not yet
  posted, or a store failure) is answered 503, so the relay sends it again instead of losing it.
- The gate and question sweeps: cards the relay missed are posted, and cards settled on the
  board are settled in chat, including a gate the board cancelled (its card moved by hand or
  archived), which closes with a receipt that names nobody.
- A person linked to nobody is told how to link, at most once a day per room.
- A production release snapshots the store first, and puts the previous release back when the
  new one fails its checks.

## Calls (superdial)

Built, not yet deployed: the LiveKit token service and the cleanup after a dead call client
([HTTP routes](/reference/routes/#superdials-token-service)). It is off until its settings are
present, needs the AgentPod hub's membership check and a LiveKit server, and supports one
homeserver: **tuwunel 2.0.0**.

## What it needs from SuperPipeline

Three things SuperExchange uses were added to SuperPipeline in **v0.0.30** (2026-11-12). Against
an older SuperPipeline they are missing, and SuperExchange degrades as described:

- **The seven notice types relayed** (`decision.reminded`, `decision.escalated`,
  `gate.approval_recorded`, `decision.released`, `decision.pulled_back`, `check.failed`,
  `check.overridden`). Without them no reminder, escalation or other notice reaches the room.
- **A service token admitted on the follow-up and waiting-card reads**
  (`GET /v1/boards/:boardId/deliveries/pending` and `GET /v1/boards/:boardId/attention/pending`,
  under `gates:read`). Without it every board reads as unreadable to those two sweeps: they settle
  nothing and back off. Follow-ups and waiting cards that arrive from the relay, and answers to
  them, work without the sweeps.
- **A service token admitted on a card's checks** (`GET /v1/boards/:boardId/cards/:cardId/checks`,
  under `gates:read`). Without it overdue checks escalate with the notice alone (a refused read
  is not retried), and when an invited admin joins, only gates and questions can be posted again
  below for them.

The question sweep needs one more scope on SuperExchange's credential: `approval-requests:relay`
for `GET /v1/boards/:boardId/elicitations/pending`. Without it, that sweep reads every board as
unreadable; questions from the relay still post and answers still act.

## What is not built

The rough edges are short enough to name plainly. You should plan around these rather than expect
the room to improvise.

- **Re-opting a board in for a new room.** A room keeps what it was made as. A room made in
  plaintext (on staging, before encryption) is not spoken in while plaintext rooms are off, and
  there is no way yet to give that board a new, encrypted room.
- **The homeserver's user and room queries.** `GET /_matrix/app/v1/users/…` and `rooms/…` answer
  `M_NOT_FOUND`: nothing in the namespace is provisioned on demand.
- **Deleting the AgentPod hub's gate code.** It follows once boards have moved.

## Things to know before relying on it

These are operational boundaries, not footnotes. Read them before moving a board, especially the
link delay and the backup requirement.

- **Only a person answers.** An agent, a sender linked to nobody, another message, another wait
  or another room is ignored; a gate answer from a sender linked to nobody gets the link hint.
- **A new Matrix link waits 15 minutes.** Accounts holds a person's self-made link for 15 minutes
  before it acts, so an answer sent sooner does not count.
- **The crypto store is as important as the database.** Lose it and the speaker loses every
  room key it holds. See [Production and backups](/operate/production/).
- **Approval requests are kept only for this service's own workspace.** An approval request
  carries every argument in full, so one on a board whose `orgId` is not the workspace of
  SuperExchange's own token is ignored.
- **Escalations invite only this service's workspace.** A board whose `orgId` is another
  workspace escalates to nobody.

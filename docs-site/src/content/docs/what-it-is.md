---
title: What SuperExchange is
description: The suite's communication server, the Matrix application service for SuperPipeline's board rooms. What it does, what it leaves to other products, and what it needs.
---

SuperExchange is the suite's communication server: a Matrix application service that carries
board work into chat and the answers back. A gate, a question, a follow-up or a waiting card on a
SuperPipeline board appears in that board's room; the board's reminders, escalations and other
notices about that work are said there; and an answer given in chat reaches the board, as the
person who gave it.

It takes those events from the suite's event relay, and it speaks in board rooms under its own
registration on the homeserver, with its own namespace (`@superexchange_*`, `#superexchange_*`)
and its own encryption keys.

## What it does

- **Carries board work into the board's room.** Gates, questions (an agent's question or a
  SuperToolkit approval request), delivery follow-ups and waiting cards, each posted once, in the
  board's end-to-end encrypted room. See [Board rooms](/board-chat/rooms/).
- **Carries answers back.** A person's answer is checked against what was posted, the
  organization plane (Accounts) says who sent it, and SuperPipeline acts on it as that person.
  One receipt follows. See [Gates](/board-chat/gates/).
- **Says what the board says about that work.** Reminders, escalations, quorum progress, held
  approvals released or pulled back, checks failed or overridden: each said once, in reply to
  its card. See [Notices](/board-chat/notices/).
- **Sweeps.** It asks each opted-in board what it still waits on, so a card the relay missed is
  posted and a gate decided elsewhere is settled in chat. See [The sweeps](/board-chat/sweeps/).

## What it is not

- **Not agent puppeting.** Agents speaking in their own station rooms, inbound prompts and
  outbound turns stay in AgentPod, as its optional Matrix adapter. SuperExchange's namespace and
  AgentPod's do not overlap.
- **Not a push gateway.** Push notifications move to SuperMessage, which holds the app's keys.
- **Not the event contract.** The shapes of every board-room event (the gate card, the question,
  the answers, the receipts) are treaty's, published as
  [`@superjackfruitlabs/treaty-matrix-events`](https://www.npmjs.com/package/@superjackfruitlabs/treaty-matrix-events).
  SuperExchange builds and reads them with treaty's code; it defines none of them.
- **Not the board, the identity service or the homeserver.** It reads SuperPipeline and Accounts
  through their public APIs and owns neither one's data. It decides its appservice registration
  and namespaces; the homeserver itself is run separately.
- **Not a chat client.** People read and answer in any Matrix client. SuperMessage shows the
  cards as cards.

## Nothing requires it

SuperPipeline remains a board without SuperExchange: its gates are still decided on the web and in
`supi`. SuperMessage remains a plain Matrix client for any homeserver. AgentPod's puppeting works
with SuperExchange absent.

SuperExchange itself needs a SuperPipeline, the [event relay](https://treaty.superjackfruit.com/relay/), a Matrix homeserver and the
organization plane (Accounts). It needs no AgentPod fleet.

## What it is made of

One Bun service (`apps/exchange`) with a SQLite store under its data directory, and the speaker's
crypto store beside it. End-to-end encryption uses `@matrix-org/matrix-sdk-crypto-nodejs`. The
board-room events come from treaty's `treaty-matrix-events`, and the relay's signed deliveries are
checked with treaty's `treaty-cloudevents`. It is MIT licensed.

**Contracts: [Treaty](https://treaty.superjackfruit.com)**, the suite's contracts as code: every
event SuperExchange takes in and every Matrix event it posts or reads has a page there.

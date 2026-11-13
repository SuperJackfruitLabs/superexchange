---
title: Gates
description: How a gate is posted to the board's room, every check an answer in chat must pass before it acts at SuperPipeline, and the one receipt that follows.
---

A gate is a decision a SuperPipeline board waits on before a card moves on. SuperExchange posts it
in the board's room and carries a person's answer back.

## Posted once

A `gate.pending` from the relay, for an opted-in and enabled board, is recorded once and posted
after a person has joined the room (see [Board rooms](/board-chat/rooms/)). The post is two
messages, both built by treaty: the [gate.v2](https://treaty.superjackfruit.com/matrix/cards/superpipeline-gate-v2/) prose message and the [gate card](https://treaty.superjackfruit.com/matrix/cards/superpipeline-gate/). Gates not yet posted
are tried again at boot, when a person joins, and by the [sweep](/board-chat/sweeps/).

## When an answer counts

Answering a gate is the one place a message in a room becomes authority somewhere else, so every
step fails closed. An answer counts only when:

1. it is a gate decision ([`dev.superpipeline.gate.decision.v1`](https://treaty.superjackfruit.com/matrix/answers/superpipeline-gate-decision-v1/) or [`.v2`](https://treaty.superjackfruit.com/matrix/answers/superpipeline-gate-decision-v2/), read by treaty's
   `parseGateDecision`), an `m.reference` to what it answers;
2. its sender is outside SuperExchange's namespace (`@superexchange_*`);
3. it was said in a board room SuperExchange owns;
4. it names a gate SuperExchange posted in that same room, and references that gate's card or its
   prose, the two identifiers checked against each other;
5. the gate's board is still opted in and enabled;
6. Accounts links the sender to a principal, and that principal is a person;
7. a gate.v2 answer names an option the gate offered, with a comment where the option needs one,
   bound to the subject (or one of the variants) the card showed;
8. no other answer holds or has used the gate's outcome.

Then Accounts asserts the sender for SuperPipeline (the assertion's `sub` must be the principal
found in step 6), SuperPipeline resolves the gate as that person, and one receipt is posted.

## What the person is told

Steps 1 to 6 refuse without a word, so a stranger or an agent can never make SuperExchange speak.
Two exceptions:

- **Accounts cannot be reached.** "I cannot check who you are right now — the account service is
  unreachable. Nothing has changed; try again in a minute." Down never reads as unlinked.
- **The sender is linked to nobody.** Once a day per room, they are told their answer did not
  count and how to link their Matrix account. See [Linking a Matrix id](/operate/linking/).

A refusal SuperPipeline gives back is said in the room, the gate stays open, and its claim is
given back so another answer can act. The exception is `GATE_NOT_PENDING`: the gate is closed.

A second answer to a gate already decided is told "That was already decided — the board has it."

## The receipt

One receipt per gate: treaty's prose line and [`dev.superpipeline.gate.outcome.v1`](https://treaty.superjackfruit.com/matrix/receipts/superpipeline-gate-outcome-v1/), pointing at the
card, which a client closes the card by. It is sent in either of two cases, whichever comes first:

- a person's answer in chat, once the board took it;
- a decision made anywhere else (on the web, in `supi`, by another path), found by the gate
  sweep.

Both claim the same outcome before anything is sent, and both send under the same transaction
ids, so even a retry is answered by the homeserver with the first send's event. A gate decided
before it was ever posted is never posted.

## Quorum, pull-backs and held approvals

A gate that needs more than one approval reports its progress in the room ("Approved by Ana — 1 of
2. Waiting for 1 more."). A held approval that is released or pulled back is said in reply to the
gate. A person can pull back an approval from chat. All of these are on
[Notices, pull-backs, overrides](/board-chat/notices/).

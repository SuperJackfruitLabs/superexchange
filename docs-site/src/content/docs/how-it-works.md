---
title: How it works
description: The path of one gate from the board to the room and back, and the parts it crosses on the way. The relay, the room, the hold, the answer, the receipt and the sweep.
---

Every kind of card SuperExchange carries follows the same path. A gate is the first and the
fullest, so this page follows one gate.

## 1. The board's event reaches SuperExchange

SuperPipeline publishes `gate.pending` to the suite's event relay. The relay delivers it to
SuperExchange's `POST /v1/relay/events` as a CloudEvent in HTTP binary mode, signed in
`x-treaty-signature` with the secret the two share (`TREATY_RELAY_DELIVERY_SECRET`). SuperExchange
checks the signature with treaty's `verifyDelivery` before it reads the body.

It keeps the event only when the board is **opted in and enabled** in its own store. An operator
does that through SuperExchange's own API: see [Opt a board in](/operate/boards/). An event for any
other board is answered `ignored`, so the relay does not retry it.

A kept gate is recorded once. A redelivery of the same gate is recorded once too, and offered for
posting again if it was not posted yet.

## 2. The board's room is made once

The first card for a board makes its room: spoken by `@superexchange_board` (shown as
"superpipeline"), with the alias `#superexchange_board_<board id>`, both names treaty's
(`boardRoomNames("superexchange")`). The room is end-to-end encrypted from its first state event.
The board's invitees are invited, each on their own, so one invite the homeserver refuses costs
nobody else the room. See [Board rooms](/board-chat/rooms/).

## 3. The gate is held until a person has joined

An invite is not enough: a card sent before anybody can read it is a card nobody answers. The gate
waits until someone outside `@superexchange_*` has joined. It is tried again at boot, when a person
joins, and by the sweep.

## 4. It is posted exactly once

Two messages, both built by treaty: the gate.v2 prose message, and the gate card. Each is sent
under a transaction id derived from the gate, so a retry is answered by the homeserver with the
first send. In an encrypted room, the room key is shared with everyone joined or invited first.

## 5. A person answers in the room

A `gate.decision` (v1 or v2, read by treaty) in that room, naming a gate SuperExchange posted there
and referencing its card or prose, from a sender outside `@superexchange_*`. Encrypted answers are
decrypted first; one whose key has not arrived yet waits. See [Encryption](/board-chat/encryption/).

## 6. Accounts says who answered

SuperExchange asks the organization plane (Accounts) which principal the sender's Matrix id is
linked to. Only a person (a `human` principal) may answer; an agent's answer is refused. A sender
linked to nobody is told how to link, at most once a day in that room. See
[Linking a Matrix id](/operate/linking/).

## 7. The board acts as that person

Accounts issues an assertion for that person with SuperPipeline as its audience, and SuperExchange
resolves the gate at SuperPipeline with it. The board records the decision as the person, not as
SuperExchange.

## 8. One receipt

A prose line and `dev.superpipeline.gate.outcome.v1`, which a client closes the card by. An answer
acts once: a repeat is told the gate was already decided.

## 9. The sweep keeps chat and board in step

Every `SUPEREXCHANGE_SWEEP_SECONDS` (60 by default), and once at boot, SuperExchange asks each
enabled board what it still waits on, with its own service token. A gate the relay never delivered
is posted; a gate decided on the web, in `supi` or anywhere else is settled in chat with the same
receipt an answer would have posted. The sweep and the answer share one claim, so a gate has one
receipt whichever path settles it. See [The sweeps](/board-chat/sweeps/).

## The parts

| Part | What SuperExchange uses it for |
| --- | --- |
| SuperPipeline | The board: where cards come from, where answers act, and what the sweeps read |
| The event relay | Delivers SuperPipeline's events, signed |
| Accounts (the organization plane) | Who a Matrix sender is, the assertion that carries them, and SuperExchange's own service token |
| The Matrix homeserver | The rooms; it calls SuperExchange with each transaction under the appservice registration |
| treaty | The board-room event contract, the room names and the relay's signature |
| SuperExchange's store | Opted-in boards, rooms, memberships, what was posted and settled, and the speaker's device |

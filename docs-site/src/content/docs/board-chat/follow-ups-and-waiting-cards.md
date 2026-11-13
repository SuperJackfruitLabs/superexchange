---
title: Follow-ups and waiting cards
description: A manual delivery that still owes the board its live link, and a card parked for a person. How each is posted, answered from chat and settled.
---

Two more cards reach the board room the same way a question does: recorded once, held until a
person has joined, encrypted where the room is, posted exactly once.

## Delivery follow-ups

A post approved for **manual delivery** still owes the board its live link. That arrives as
`delivery.pending` (`com.superjackfruit.superpipeline.delivery.pending.v1`) and is recorded once
per gate.

**The card** is one message, treaty's delivery.v2: the exact post, and two choices:

- record the live link;
- switch to automatic delivery, offered only when the whole post could be shown.

**The answer** is a `dev.superpipeline.delivery.answer.v2` naming the gate and referencing that
message. It is judged against what was recorded: an `https://` link within the limit, or automatic
delivery only on a complete preview. It is carried as that person:

```http
POST /v1/boards/:boardId/gates/:gateId/delivery
{ "liveUrl": "https://…" }    or    { "mode": "automatic" }
```

**One receipt**: a line naming who, and `dev.superpipeline.gate.outcome.v1` at the follow-up.

## Waiting cards

A card parked for a person (repeated failure, blocked, not authorised) arrives as
`attention.pending` (`com.superjackfruit.superpipeline.attention.pending.v1`). It is recorded once
per wait: board, card and wait id. A card that parks again is a new waiting card.

**The card** is one message, treaty's attention.v2, offering three choices: resume here, resume at
an earlier stage, or archive.

**Its age.** A card can be posted long after it was raised: the sweep finds a wait from before the
board was opted in, or the card is held until somebody joins. When the card was raised an hour or
more before it is posted, its summary leads with when, in UTC, and how long before the post:

> Raised 6 Nov, 06:32 UTC, 7 days before this card was posted; what it says is as of then.

The agent's words and the failure count on the card are as of the raise, not as of the post. The
raise time is the board's `ts` on `attention.pending`, the time the card started waiting. A card
re-posted for an escalation says its age as of that post. The card carries no live state: anything
showing where the card is now, such as its stage, its age in that stage or its attempt, comes from
the board, read when it is shown.

**The answer** is a `dev.superpipeline.attention.answer.v2` naming that wait and referencing that
message, carried as that person:

```http
POST /v1/boards/:boardId/cards/:cardId/resume
{ "comment": "…", "toStageKey": "…", "expectedWaitId": "…" }

POST /v1/boards/:boardId/cards/:cardId/archive
{ "expectedWaitId": "…", "comment": "…" }
```

`toStageKey` is given only to resume at an earlier stage; the archive's `comment` is optional. A
resume needs an instruction for the next attempt, at most 2730 characters.

**One receipt** settles the card, and only one: a line in reply to the card ("Resumed by Ana — the
board has it."), and `dev.superpipeline.attention.outcome.v1` referencing the card's message. An
updated client closes the card by the outcome and draws the receipt in place of its choices. The
reply is what ties the line to its card in any other client. In an encrypted room all three are
sent encrypted.

A waiting card is settled:

- when it is answered from chat and the board takes the answer;
- when the sweep no longer finds its wait: it was resumed or archived on the web or with `supi`, it
  left its stage, or it waits on something else now. The line says "This card is no longer waiting
  — it was settled on the board." and names nobody;
- when an answer from chat finds the wait already changed (below).

When the board says the wait has changed (`WAIT_CHANGED`: the card was resumed, archived or moved
on the board, or waits on something else now), the room is told so in words and the card is closed
with its outcome only.

## Who may answer

For both, only a person. An agent, a sender linked to nobody, another message, another wait or
another room is ignored without a word. A refusal the board gives is said in the room.

## The sweeps for these two

The follow-up and waiting-card sweeps run on the same interval as the others, each with its own
backoff, and read each enabled board's `GET /v1/boards/:boardId/deliveries/pending` and
`GET /v1/boards/:boardId/attention/pending` with SuperExchange's own token. One the relay missed is
posted. One the board no longer lists is settled with one receipt naming nobody ("settled on the
board"), or never posted.

These two reads need SuperPipeline v0.0.30 or later, which admits a service token on them under
`gates:read`. Against an older SuperPipeline every board reads as unreadable to these sweeps:
nothing is settled by them, and they back off. The relay path and the answers work without them.
See [Status and limits](/status/).

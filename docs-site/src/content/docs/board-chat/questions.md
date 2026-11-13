---
title: Questions and approvals
description: An agent's question and a SuperToolkit approval request in the board's room, the two ways to answer them, and the rules that keep an approval bound to what it showed.
---

A board question is one of two things waiting on a person's answer:

- **an agent's question**: an agent blocked until somebody answers it;
- **an approval request**: a SuperToolkit approval waiting on a person, carrying the exact
  operation and every argument in full.

Both arrive as `elicitation.pending` (CloudEvents type
`com.superjackfruit.superpipeline.elicitation.pending.v1`).

## Posted once

A question for an opted-in, enabled board is recorded once and posted like a gate: held until a
person has joined, encrypted where the room is, exactly once. It is one message, built by treaty:
the question.v2 prose with the v1 card (`dev.superpipeline.elicitation`) inside it.

**An approval request is kept only for this service's own workspace.** Because it carries every
argument in full, one is kept only when the board's `orgId` is the workspace of SuperExchange's own
token (its `org` claim). Any other is ignored, by the relay route and the sweep alike.

## Two ways to answer

The answer is carried to SuperPipeline as the person who gave it
(`POST /v1/boards/:boardId/elicitations/:elicitationId/answer`, with Accounts' assertion, as for
gates).

### A question.answer.v2

A `dev.superpipeline.question.answer.v2` naming its question and referencing the message that asked
it. It is judged against what was recorded when the question was posted: an option it offered,
with the input that option asks for, bound to the subject it showed. Approving an incomplete
preview, or approving after expiry, is refused.

### A typed reply

An ordinary `m.text` message in the board room: the **number, label or id** of an option of the
question open in the room. The open question is the newest one posted without a receipt, an agent's
question before an approval request. This is what makes a question answerable from any Matrix
client.

Nothing is guessed. Anything that is not plainly an option gives a linked person the options
again. **A typed reply never approves a subject-bound question**: it can only decline it, and an
attempt to approve is told to open it in an updated app or on the board.

## Who may answer

- **An approval request:** only a person (a `human` principal). An agent's answer is refused
  without a word.
- **An agent's question:** any sender Accounts links to a principal.
- **An approval request whose subject could not be carried** is never allowed from a room; only a
  decline goes on.

A sender linked to nobody, a room SuperExchange does not own, a question it never posted there, a
reference to another message, or a board no longer opted in is ignored without a word.

## What the room is told

- An option the question did not offer: "That is not one of this question's options. Nothing has
  changed."
- An option that needs text, or an `https://` link, without it.
- The board's refusals, in words: a decision answered for a different version, an expired
  decision, an approval only a workspace owner or admin may give, or the requester trying to
  decide their own request.
- One receipt when the board takes the answer ("Answered: …").

## When the board stops waiting

The [question sweep](/board-chat/sweeps/) reads each enabled board's pending questions. A question
the relay missed is posted. A question the board no longer lists (answered on the board, or retired
by the agent's next question) is closed with one line, "That question is closed — it was answered on
the board, or the agent has moved on.", or never posted if it was not posted yet. A board that cannot
be read closes nothing. A question with a receipt never reaches the board again.

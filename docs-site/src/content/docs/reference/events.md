---
title: Events carried
description: The CloudEvents SuperExchange takes from the relay, and the Matrix content it posts and reads in board rooms. Every shape is treaty's.
---

SuperExchange defines none of these. The CloudEvents types and their bodies are SuperPipeline's,
catalogued by [Treaty](https://treaty.superjackfruit.com/events/); the Matrix content is treaty's board-room contract,
[`@superjackfruitlabs/treaty-matrix-events`](https://www.npmjs.com/package/@superjackfruitlabs/treaty-matrix-events),
with one JSON Schema per type ([Treaty's Matrix catalogue](https://treaty.superjackfruit.com/matrix/) has a page for each). Type strings never change; a breaking change is a new version
published beside the old one.

## In from the relay

Every type is `com.superjackfruit.superpipeline.<event>.v1`.

| Event | What it is | Page |
| --- | --- | --- |
| [`gate.pending`](https://treaty.superjackfruit.com/events/gate-pending-v1/) | A gate waiting on a decision | [Gates](/board-chat/gates/) |
| [`elicitation.pending`](https://treaty.superjackfruit.com/events/elicitation-pending-v1/) | An agent's question, or an approval request | [Questions](/board-chat/questions/) |
| [`delivery.pending`](https://treaty.superjackfruit.com/events/delivery-pending-v1/) | A manual delivery that owes its live link | [Follow-ups](/board-chat/follow-ups-and-waiting-cards/) |
| [`attention.pending`](https://treaty.superjackfruit.com/events/attention-pending-v1/) | A card parked for a person | [Waiting cards](/board-chat/follow-ups-and-waiting-cards/) |
| [`decision.reminded`](https://treaty.superjackfruit.com/events/decision-timeout-v1/) | An unanswered decision, reminded | [Notices](/board-chat/notices/) |
| [`decision.escalated`](https://treaty.superjackfruit.com/events/decision-timeout-v1/) | An unanswered decision, escalated | [Notices](/board-chat/notices/) |
| [`gate.approval_recorded`](https://treaty.superjackfruit.com/events/gate-approval-recorded-v1/) | One approval of a quorum gate | [Notices](/board-chat/notices/) |
| [`decision.released`](https://treaty.superjackfruit.com/events/decision-released-v1/) | A held approval released | [Notices](/board-chat/notices/) |
| [`decision.pulled_back`](https://treaty.superjackfruit.com/events/decision-pulled-back-v1/) | A held approval pulled back | [Notices](/board-chat/notices/) |
| [`check.failed`](https://treaty.superjackfruit.com/events/check-failed-v1/) | A machine check failed | [Notices](/board-chat/notices/) |
| [`check.overridden`](https://treaty.superjackfruit.com/events/check-overridden-v1/) | A failed check overridden | [Notices](/board-chat/notices/) |

## Out to the room

| Card or message | Content |
| --- | --- |
| Gate | The [gate.v2](https://treaty.superjackfruit.com/matrix/cards/superpipeline-gate-v2/) prose message and the [gate card](https://treaty.superjackfruit.com/matrix/cards/superpipeline-gate/) |
| Question | The [question.v2](https://treaty.superjackfruit.com/matrix/cards/superpipeline-question-v2/) prose with the v1 card ([`dev.superpipeline.elicitation`](https://treaty.superjackfruit.com/matrix/cards/superpipeline-elicitation/)) inside it |
| Delivery follow-up | treaty's [delivery.v2](https://treaty.superjackfruit.com/matrix/cards/superpipeline-delivery-v2/) |
| Waiting card | treaty's [attention.v2](https://treaty.superjackfruit.com/matrix/cards/superpipeline-attention-v2/) |
| Gate receipt | A prose line and [`dev.superpipeline.gate.outcome.v1`](https://treaty.superjackfruit.com/matrix/receipts/superpipeline-gate-outcome-v1/) |
| Follow-up receipt | A line naming who, and [`dev.superpipeline.gate.outcome.v1`](https://treaty.superjackfruit.com/matrix/receipts/superpipeline-gate-outcome-v1/) |
| Waiting-card receipt | A line, and [`dev.superpipeline.attention.outcome.v1`](https://treaty.superjackfruit.com/matrix/receipts/superpipeline-attention-outcome-v1/) |
| Quorum progress | A line, and [`dev.agentpod.gate.progress.v2`](https://treaty.superjackfruit.com/matrix/notices/agentpod-gate-progress-v2/) |
| Released, pulled back | A line, and [`dev.agentpod.decision.released.v2`](https://treaty.superjackfruit.com/matrix/notices/agentpod-decision-released-v2/) / [`dev.agentpod.decision.pulled_back.v2`](https://treaty.superjackfruit.com/matrix/notices/agentpod-decision-pulled-back-v2/) |
| Checks waiting (an escalation of overdue checks) | [`dev.agentpod.checks.waiting.v2`](https://treaty.superjackfruit.com/matrix/cards/agentpod-checks-waiting-v2/) |
| Check failed, overridden | A line, and [`dev.agentpod.check.failed.v2`](https://treaty.superjackfruit.com/matrix/notices/agentpod-check-failed-v2/) / [`dev.agentpod.check.overridden.v2`](https://treaty.superjackfruit.com/matrix/notices/agentpod-check-overridden-v2/) |

In an encrypted room each is sent as `m.room.encrypted`.

## In from the room

| Answer | Answers |
| --- | --- |
| [`dev.superpipeline.gate.decision.v1`](https://treaty.superjackfruit.com/matrix/answers/superpipeline-gate-decision-v1/), [`.v2`](https://treaty.superjackfruit.com/matrix/answers/superpipeline-gate-decision-v2/) | A gate |
| [`dev.superpipeline.question.answer.v2`](https://treaty.superjackfruit.com/matrix/answers/superpipeline-question-answer-v2/) | A question |
| `m.text` (a typed reply: an option's number, label or id) | The question open in the room |
| [`dev.superpipeline.delivery.answer.v2`](https://treaty.superjackfruit.com/matrix/answers/superpipeline-delivery-answer-v2/) | A delivery follow-up |
| [`dev.superpipeline.attention.answer.v2`](https://treaty.superjackfruit.com/matrix/answers/superpipeline-attention-answer-v2/) | A waiting card |
| [`dev.superpipeline.gate.pull_back.v2`](https://treaty.superjackfruit.com/matrix/answers/superpipeline-gate-pull-back-v2/) | Pulls back an approval of a gate posted here |
| [`dev.superpipeline.check.override.v2`](https://treaty.superjackfruit.com/matrix/answers/superpipeline-check-override-v2/) | Overrides a check on a checks.waiting card posted here |

Each structured answer must reference the message it answers (`m.reference`), in the room
SuperExchange posted it in. A typed reply references nothing: it is matched against the question
open in that room, and can never approve a subject-bound question.

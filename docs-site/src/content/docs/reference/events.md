---
title: Events carried
description: The CloudEvents SuperExchange takes from the relay, and the Matrix content it posts and reads in board rooms. Every shape is treaty's.
---

SuperExchange defines none of these. The CloudEvents types and their bodies are SuperPipeline's,
catalogued by treaty; the Matrix content is treaty's board-room contract,
[`@superjackfruitlabs/treaty-matrix-events`](https://www.npmjs.com/package/@superjackfruitlabs/treaty-matrix-events),
with one JSON Schema per type. Type strings never change; a breaking change is a new version
published beside the old one.

## In from the relay

Every type is `com.superjackfruit.superpipeline.<event>.v1`.

| Event | What it is | Page |
| --- | --- | --- |
| `gate.pending` | A gate waiting on a decision | [Gates](/board-chat/gates/) |
| `elicitation.pending` | An agent's question, or an approval request | [Questions](/board-chat/questions/) |
| `delivery.pending` | A manual delivery that owes its live link | [Follow-ups](/board-chat/follow-ups-and-waiting-cards/) |
| `attention.pending` | A card parked for a person | [Waiting cards](/board-chat/follow-ups-and-waiting-cards/) |
| `decision.reminded` | An unanswered decision, reminded | [Notices](/board-chat/notices/) |
| `decision.escalated` | An unanswered decision, escalated | [Notices](/board-chat/notices/) |
| `gate.approval_recorded` | One approval of a quorum gate | [Notices](/board-chat/notices/) |
| `decision.released` | A held approval released | [Notices](/board-chat/notices/) |
| `decision.pulled_back` | A held approval pulled back | [Notices](/board-chat/notices/) |
| `check.failed` | A machine check failed | [Notices](/board-chat/notices/) |
| `check.overridden` | A failed check overridden | [Notices](/board-chat/notices/) |

## Out to the room

| Card or message | Content |
| --- | --- |
| Gate | The gate.v2 prose message and the gate card |
| Question | The question.v2 prose with the v1 card (`dev.superpipeline.elicitation`) inside it |
| Delivery follow-up | treaty's delivery.v2 |
| Waiting card | treaty's attention.v2 |
| Gate receipt | A prose line and `dev.superpipeline.gate.outcome.v1` |
| Follow-up receipt | A line naming who, and `dev.superpipeline.gate.outcome.v1` |
| Waiting-card receipt | A line, and `dev.superpipeline.attention.outcome.v1` |
| Quorum progress | A line, and `dev.agentpod.gate.progress.v2` |
| Released, pulled back | A line, and `dev.agentpod.decision.released.v2` / `dev.agentpod.decision.pulled_back.v2` |
| Checks waiting (an escalation of overdue checks) | `dev.agentpod.checks.waiting.v2` |
| Check failed, overridden | A line, and `dev.agentpod.check.failed.v2` / `dev.agentpod.check.overridden.v2` |

In an encrypted room each is sent as `m.room.encrypted`.

## In from the room

| Answer | Answers |
| --- | --- |
| `dev.superpipeline.gate.decision.v1`, `.v2` | A gate |
| `dev.superpipeline.question.answer.v2` | A question |
| `m.text` (a typed reply: an option's number, label or id) | The question open in the room |
| `dev.superpipeline.delivery.answer.v2` | A delivery follow-up |
| `dev.superpipeline.attention.answer.v2` | A waiting card |
| `dev.superpipeline.gate.pull_back.v2` | Pulls back an approval of a gate posted here |
| `dev.superpipeline.check.override.v2` | Overrides a check on a checks.waiting card posted here |

Each structured answer must reference the message it answers (`m.reference`), in the room
SuperExchange posted it in. A typed reply references nothing: it is matched against the question
open in that room, and can never approve a subject-bound question.

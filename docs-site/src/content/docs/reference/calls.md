---
title: What it calls
description: Every request SuperExchange makes to Accounts, SuperPipeline and the homeserver, with the credential each is made with and the scope it needs.
---

SuperExchange reads SuperPipeline and Accounts only through their public APIs, and owns neither
one's data.

## Accounts (`ORG_PLANE_URL`)

Every call carries SuperExchange's service credential (`ORG_PLANE_SERVICE_CREDENTIAL`) as a bearer.
A plane that cannot answer is never read as "nobody".

| Request | For |
| --- | --- |
| `GET /api/identities/matrix/:mxid` | The principal a Matrix sender is linked to; 404 is nobody (a link still in its 15-minute hold reads as nobody too) |
| `GET /api/principals/:id` | What kind of principal that is (`human`, `agent`, `service`), and how a receipt names them: display name, else handle |
| `POST /api/token/assertion` `{ identity: { system: "matrix", externalId }, audience }` | An assertion of the sender for SuperPipeline. Its `sub` must be the principal resolved above, or the answer is refused |
| `GET /api/principals?kind=human` | The workspace's people with their `role`, for an escalation: owners and admins, not suspended |
| `GET /api/principals/:id/identities?system=matrix` | Each such admin's linked Matrix id; an admin who linked none is not invited |
| `POST /api/token/service` `{ audience }` | SuperExchange's own token for SuperPipeline (audience `SUPERPIPELINE_URL`), held until shortly before it expires |

## SuperPipeline (`SUPERPIPELINE_URL`)

### As the person who answered

Each with Accounts' assertion for that person.

| Request | For |
| --- | --- |
| `POST /v1/boards/:boardId/gates/:gateId/resolve` | A gate answer: `{ decision, comment?, approvalSubjectId?, approvalSubjectDigest? }` |
| `POST /v1/boards/:boardId/elicitations/:elicitationId/answer` | A question's answer |
| `POST /v1/boards/:boardId/gates/:gateId/delivery` | A follow-up: `{ liveUrl }` or `{ mode: "automatic" }` |
| `POST /v1/boards/:boardId/cards/:cardId/resume` | A waiting card resumed: `{ comment, toStageKey?, expectedWaitId }` |
| `POST /v1/boards/:boardId/cards/:cardId/archive` | A waiting card archived: `{ expectedWaitId, comment? }` |
| `POST /v1/boards/:boardId/gates/:gateId/pull-back` | A pull-back: `{ comment }` |
| `POST /v1/boards/:boardId/cards/:cardId/checks/:name/override` | A check override: `{ comment }` |

### As itself

With its own service token, on SuperPipeline's service routes.

| Request | Scope | For |
| --- | --- | --- |
| `GET /v1/boards/:boardId/gates/pending` | `gates:read` | The gate sweep |
| `GET /v1/boards/:boardId/gates/:gateId` | `gates:read` | One gate, and how it was decided |
| `GET /v1/boards/:boardId/elicitations/pending` | `approval-requests:relay` | The question sweep |
| `GET /v1/boards/:boardId/deliveries/pending` | `gates:read` | The follow-up sweep (SuperPipeline v0.0.30 or later) |
| `GET /v1/boards/:boardId/attention/pending` | `gates:read` | The waiting-card sweep (SuperPipeline v0.0.30 or later) |
| `GET /v1/boards/:boardId/cards/:cardId/checks` | `gates:read` | An escalation of overdue checks, and re-posting for a joining admin (SuperPipeline v0.0.30 or later) |

## The homeserver (`MATRIX_HOMESERVER_URL`)

As the appservice, with `MATRIX_AS_TOKEN`, through the client-server API: registering and naming the
speaker, the appservice login that gives the speaker its device, creating rooms, resolving an alias,
reading a room's encryption state and joined members, inviting, sending (encrypted or not), and the
encryption machinery's own requests (keys upload, query and claim, to-device messages).

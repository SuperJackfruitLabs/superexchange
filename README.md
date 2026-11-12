# SuperExchange

The suite's communication server: a Matrix Application Service that carries board work into chat
and the answers back. A gate, a question, a follow-up or a waiting card on a SuperPipeline board
appears in that board's room, the board's reminders, escalations and other notices about it are said
there, and an answer given in chat reaches the board. It takes those
events from the suite's event relay, and it speaks in board rooms under its own registration on
the homeserver.

Agent puppeting stays in AgentPod, and the push gateway moves to SuperMessage. The event formats
are treaty's ([`@superjackfruitlabs/treaty-matrix-events`](https://www.npmjs.com/package/@superjackfruitlabs/treaty-matrix-events)):
SuperExchange carries them, it does not define them.

Nothing requires it. SuperPipeline remains a board without it, and SuperMessage remains a plain
Matrix client. SuperExchange itself needs a SuperPipeline, an event relay and a Matrix homeserver.

## Status

Board rooms and the gate card. The service keeps its own store, answers the homeserver's
appservice transactions, and takes `gate.pending` from the event relay for the boards an operator
has opted in. For each such gate it makes the board's room once (speaker
`@superexchange_board`, shown as "superpipeline"; alias `#superexchange_board_<board id>`),
invites the board's people, holds the gate until one of them has joined, then posts it exactly
once: the gate.v2 prose message and the gate card, both built by treaty. Gates not yet posted are
tried again at boot, when a person joins, and by the sweep.

A person's answer to a gate card (`gate.decision` v1 or v2, read by treaty) is carried back: in a
board room this service owns, naming a gate it posted there and referencing its card or prose,
from a sender outside `@superexchange_*`. The organization plane says who the sender is; only a
person may answer, and a gate.v2 answer must name an option, subject or variant the gate offered.
The plane then asserts the sender for SuperPipeline, the gate is resolved there as that person,
and one receipt is posted (a prose line and `dev.superpipeline.gate.outcome.v1`). An answer acts
once: a repeat is told the gate was already decided.

**The gate sweep** asks every enabled board, one at a time, what it is still waiting on: at boot
and every `SUPEREXCHANGE_SWEEP_SECONDS`. It reads with this service's own token from the
organization plane (`POST /api/token/service`, audience `SUPERPIPELINE_URL`, held until shortly
before it expires), which needs the `gates:read` scope on SuperPipeline's service routes
(`GET /v1/boards/:boardId/gates/pending` and `GET /v1/boards/:boardId/gates/:gateId`).

- A pending gate the relay never delivered here is recorded as if it had been, and posted like
  any other. A delivered gate not yet posted is offered again.
- A gate decided anywhere else (on the web, in `supi`, by another path) is settled: when the
  board reads it as resolved, the receipt an answer in chat would have posted (treaty's prose
  line and `dev.superpipeline.gate.outcome.v1`, pointing at the card) is posted once, encrypted
  in an encrypted room. The sweep and the answer path share one claim, so a gate answered in chat
  and then seen resolved has one receipt; a later answer in chat is told it was already decided.
  A gate decided before it was ever posted is never posted.
- A gate the board does not read as resolved with a decision is left as it is: absence from the
  pending list is not a decision. A board that cannot be read (404 for a board outside this
  service's workspace, 403 without `gates:read`, the board or the plane down) settles nothing,
  is logged, and the boards after it are still asked. A pass in which every board failed waits
  twice as long before the next, up to eight times the interval.

**Board questions.** An agent blocked on a person's answer, or a SuperToolkit approval request
waiting on one, arrives as `elicitation.pending` (CloudEvents type
`com.superjackfruit.superpipeline.elicitation.pending.v1`) for an opted-in, enabled board, and is
recorded once and posted like a gate: held until a person has joined, encrypted where the room is,
exactly once. A question is one message, built by treaty: the question.v2 prose with the v1 card
(`dev.superpipeline.elicitation`) inside it. An approval request carries every argument in full, so
it is kept only when the board's `orgId` is the workspace of this service's own token (its `org`
claim); any other is ignored, by the relay route and the sweep alike.

A person answers in two ways, and the answer is carried to SuperPipeline as that person
(`POST /v1/boards/:boardId/elicitations/:elicitationId/answer`, with the organization plane's
assertion, as for gates):

- a `dev.superpipeline.question.answer.v2`, naming its question and referencing the message that
  asked it, judged against what was recorded when it was posted: an option it offered, with the
  input that option asks for, bound to the subject it showed (an approval of an incomplete preview,
  or after expiry, is refused);
- a typed reply (`m.text`): the number, label or id of an option of the question open in the room,
  an agent's question before an approval request. Nothing is guessed: anything else gives a
  linked person the options again. A typed reply never approves a subject-bound question; it can
  only decline it.

Only a person answers an approval request, and one whose subject could not be carried is never
allowed from a room. Refusals are said in the room as the hub says them, and one receipt is posted
("Answered: …"). The question sweep (same interval, its own backoff) reads each enabled board's
pending questions with this service's own token (`GET /v1/boards/:boardId/elicitations/pending`,
which needs `approval-requests:relay`): a question the relay missed is posted, and a question the
board no longer lists (answered on the board, or retired by the agent's next question) is closed
with one line, or never posted. A board that cannot be read closes nothing.

**Delivery follow-ups.** A post approved for manual delivery still owes the board its live link:
`delivery.pending` (CloudEvents type `com.superjackfruit.superpipeline.delivery.pending.v1`) for an
opted-in, enabled board is recorded once per gate and posted like a question (held until a person
has joined, encrypted where the room is, exactly once): one message, treaty's delivery.v2, showing
the exact post and two choices, record the live link or switch to automatic delivery (offered only
when the whole post could be shown). A person's `dev.superpipeline.delivery.answer.v2`, naming the
gate and referencing that message, is judged against what was recorded: an `https://` link within
the limit, or automatic delivery only on a complete preview. It is carried as that person
(`POST /v1/boards/:boardId/gates/:gateId/delivery`, `{ liveUrl }` or `{ mode: "automatic" }`), and
one receipt is posted: a line naming who, and `dev.superpipeline.gate.outcome.v1` at the follow-up.

**Waiting cards.** A card parked for a person (repeated failure, blocked, not authorised):
`attention.pending` (`com.superjackfruit.superpipeline.attention.pending.v1`) is recorded once per
wait (board, card, wait id; a card that parks again is a new card) and posted the same way: one
message, treaty's attention.v2, offering resume here, resume at an earlier stage, or archive. A
person's `dev.superpipeline.attention.answer.v2` naming that wait and referencing that message is
carried as that person (`POST /v1/boards/:boardId/cards/:cardId/resume` with
`{ comment, toStageKey?, expectedWaitId }`, or `…/archive` with `{ expectedWaitId, comment? }`). A
resume needs an instruction for the next attempt (at most 2730 characters). One receipt is posted:
a line, and `dev.superpipeline.attention.outcome.v1` at the card. When the board says the wait has
changed (`WAIT_CHANGED`), the room is told in words and the card is closed with its outcome only.

For both, only a person answers; an agent, an unlinked sender, another message, another wait or
another room is ignored without a word, and a refusal the board gives is said in the room. **The
follow-up and waiting-card sweeps** (same interval, each with its own backoff) read each enabled
board's `GET /v1/boards/:boardId/deliveries/pending` and `GET /v1/boards/:boardId/attention/pending`
with this service's own token: one the relay missed is posted, and one the board no longer lists is
settled with one receipt naming nobody ("settled on the board"), or never posted. **SuperPipeline
does not yet admit a service token on either read**: they are agent-or-person routes there. Until
it serves both on its service routes under `gates:read` (as it serves `gates/pending`), every board
reads as unreadable to these two sweeps, nothing is settled by them, and they back off; the relay
path and answers work without them.

**Board-room notices.** What the board says about work already in a room arrives from the relay
as seven CloudEvents types (`com.superjackfruit.superpipeline.…v1`), each checked with treaty's
predicate and its `event`, for opted-in, enabled boards, recorded once and said once as a reply to
the card it concerns, built by treaty:

- `decision.reminded`: treaty's notice in reply to the waiting card (a gate, question, follow-up or
  waiting card). Overdue checks have no card: their reminder stands alone.
- `decision.escalated`: the workspace's owners and admins with a linked Matrix id are invited into
  the room, each once per board (one who leaves is not invited back; an invite the homeserver
  refuses is tried at the next escalation), then the notice in reply to the card. The plane lists
  this service's own workspace (`GET /api/principals?kind=human`, then
  `GET /api/principals/:id/identities?system=matrix`, needing `principals:read` and
  `identities:read`), so a board whose `orgId` is another workspace escalates to nobody. Overdue
  checks escalate with a `dev.agentpod.checks.waiting.v2` card listing them, read from
  `GET /v1/boards/:boardId/cards/:cardId/checks`; the notice replies to it. When an invited admin
  joins, each still-open escalated card is posted again below from a fresh read of the board (its
  record moves to the new copy only if the board still offers what was recorded; the old copy is
  told it moved, and an answer to it then acts on nothing), and the notice again in reply to it. A
  board that cannot be read gets the notice alone.
- `gate.approval_recorded`: a quorum gate's progress ("Approved by Ana — 1 of 2. Waiting for 1
  more.") in reply to the gate, and `dev.agentpod.gate.progress.v2`; the count is recorded on the
  gate, never walked back.
- `decision.released`, `decision.pulled_back`: in reply to the gate (settled or not: they follow a
  held approval's receipt), and `dev.agentpod.decision.released.v2` / `….pulled_back.v2`.
- `check.failed`, `check.overridden`: a line in the board's room, in reply to the open
  checks.waiting card for that card and stage when there is one, and the structured half
  (`dev.agentpod.check.failed.v2` / `….overridden.v2`). A failure that sent the card back closes
  that card.

A notice about a card this service never posted (or one already settled, for a reminder, an
escalation or progress) is answered `ignored` and never said, as the hub does. Who did something is
named by the plane's label, never an id. Each send is under a transaction id derived from the
notice; one that fails keeps its claim and is sent again at boot, when a person joins, and every
`SUPEREXCHANGE_SWEEP_SECONDS`.

**Pull-backs and overrides from chat.** A `dev.superpipeline.gate.pull_back.v2` referencing a gate
posted here, in its room, and a `dev.superpipeline.check.override.v2` referencing a checks.waiting
card posted here (its room, board and card), are carried as the person who sent them
(`POST /v1/boards/:boardId/gates/:gateId/pull-back` and
`POST /v1/boards/:boardId/cards/:cardId/checks/:name/override`, each `{ comment }`, with the
organization plane's assertion). Only a person; a comment is required, within 8192 bytes; the
board's refusal is said in the room. Success says nothing: the board's `decision.pulled_back` or
`check.overridden` does.

**SuperPipeline must still:** relay the seven notice types to SuperExchange; and admit this
service's token on `GET /v1/boards/:boardId/cards/:cardId/checks` (it is a person-or-agent route
there). Until it does, overdue checks escalate with the notice alone (a refused read is not
retried), and the re-post on an admin's join can move only gates and questions (the follow-up and
waiting-card lists are not admitted either, above).

**Board rooms are end-to-end encrypted, with SuperExchange's own keys.** The speaker has one
device, taken once from an appservice login and recorded in the store, so a restart reuses it;
its keys live in an on-disk store under `SUPEREXCHANGE_DATA_DIR/crypto/`, encrypted with
`SUPEREXCHANGE_CRYPTO_PASSPHRASE`. Back that directory up with the database: lose it and the
speaker loses every room key it holds. A new board room is made with `m.room.encryption`
(Megolm); the gate, its prose, replies and receipts are encrypted to everyone joined or invited.
A person's encrypted answer is decrypted before it is read; one whose key has not arrived yet
waits in the store, still encrypted, is tried again whenever keys arrive and at boot, and is given
up after an hour. The homeserver's registration needs `de.sorunome.msc2409.push_ephemeral: true`
and `org.matrix.msc3202: true` (to-device events, device lists and key counts in transactions),
and `io.element.msc4190: false` (it turns appservice login off).

`SUPEREXCHANGE_PLAINTEXT_ROOMS=on` makes new rooms in plaintext instead, and is refused on any
homeserver whose server name does not start with `staging-`. A room keeps what it was made as:
an encrypted room never gets plaintext, and a room made in plaintext (staging, before encryption)
is left as it is. With the switch off nothing is posted into such a room, encrypted or not; that
board's chat comes back when it is re-opted in for a new room (not built yet).

| Route                                                | Who calls it   | What it does                                                                                                                           |
| ---------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                       | anyone         | The health check                                                                                                                       |
| `PUT /_matrix/app/v1/transactions/:txn`              | the homeserver | Events in, applied once per transaction id                                                                                             |
| `POST /_matrix/app/v1/ping`                          | the homeserver | `{}`                                                                                                                                   |
| `GET /_matrix/app/v1/users/…`, `rooms/…`             | the homeserver | `M_NOT_FOUND` until rooms move here                                                                                                    |
| `POST /v1/relay/events`                              | the relay      | A signed `gate.pending`, `elicitation.pending`, `delivery.pending`, `attention.pending` or board-room notice, kept for opted-in boards |
| `GET /v1/boards`, `PUT`/`DELETE /v1/boards/:boardId` | the operator   | Opt a board in, disable it, list them                                                                                                  |

## Run it

```sh
bun install
MATRIX_HOMESERVER_URL=http://127.0.0.1:6167 \
MATRIX_SERVER_NAME=example.test \
MATRIX_AS_TOKEN=… MATRIX_HS_TOKEN=… \
TREATY_RELAY_DELIVERY_SECRET=… \
SUPEREXCHANGE_OPERATOR_TOKEN_SHA256=$(printf %s "$OPERATOR_TOKEN" | shasum -a 256 | cut -d' ' -f1) \
SUPEREXCHANGE_DATA_DIR=$PWD/.data \
ORG_PLANE_URL=https://accounts.example ORG_PLANE_SERVICE_CREDENTIAL=svc_…:… \
SUPEREXCHANGE_CRYPTO_PASSPHRASE=$(openssl rand -base64 32) \
SUPERPIPELINE_URL=https://pipeline.example \
bun apps/exchange/src/main.ts
curl http://127.0.0.1:8080/healthz
```

| Setting                               | What it is                                                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATRIX_HOMESERVER_URL`               | Where the homeserver's client-server API answers                                                                                                                            |
| `MATRIX_SERVER_NAME`                  | The homeserver's server name                                                                                                                                                |
| `MATRIX_AS_TOKEN`                     | The `as_token` of this appservice's registration                                                                                                                            |
| `MATRIX_HS_TOKEN`                     | The `hs_token` of this appservice's registration                                                                                                                            |
| `TREATY_RELAY_DELIVERY_SECRET`        | The secret the event relay signs its deliveries to this service                                                                                                             |
| `SUPEREXCHANGE_OPERATOR_TOKEN_SHA256` | The SHA-256 (64 hex digits) of the operator's bearer token for `/v1/boards`                                                                                                 |
| `SUPEREXCHANGE_DATA_DIR`              | The directory the store's database lives in; `/data` when unset                                                                                                             |
| `PORT`                                | Where it listens; 8080 when unset                                                                                                                                           |
| `SUPEREXCHANGE_PLAINTEXT_ROOMS`       | `on` or `off` (default). Staging only: see Status                                                                                                                           |
| `SUPEREXCHANGE_CRYPTO_PASSPHRASE`     | At least 32 characters; encrypts the speaker's crypto store. Required while plaintext rooms are off; unset, nothing is encrypted                                            |
| `ORG_PLANE_URL`                       | Where the organization plane (Accounts) answers                                                                                                                             |
| `ORG_PLANE_SERVICE_CREDENTIAL`        | This service's credential there, `svc_<20 hex>:<secret>`                                                                                                                    |
| `SUPERPIPELINE_URL`                   | SuperPipeline's API, where gates are resolved and read; also the assertion and service-token audience                                                                       |
| `SUPEREXCHANGE_SWEEP_SECONDS`         | How often the gate, question, follow-up and waiting-card sweeps ask each enabled board, and unposted notices are tried again: whole seconds from 15 to 86400; 60 when unset |

A missing or malformed setting stops it before it listens, naming the setting, never its value.

## Production

A `vX.Y.Z` tag on main deploys production (`release.yml` in the GitHub workflows, on the GitHub
mirror only): after `bun run check` passes, the production host runs that tag's
`deploy/production/release.sh` through its forced-command deploy key. Only the operator pushes
tags. The workflow does nothing until the mirror has the `PROD_HOST` variable and the
`PROD_SSH_KEY` and `PROD_KNOWN_HOSTS` secrets.

`release.sh` builds the tag's image, recreates the service (`deploy/production/compose.yml`),
waits for `/healthz` and checks that the service reaches the homeserver. If the release fails
those checks, the release that ran before is put back. Before each release it takes an online
copy of the store; on a rollback it restores that copy when the new build had moved the schema,
because a build refuses a database written by a newer one.

| What           | Where                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| Settings       | `/etc/superexchange/superexchange.env`, written by the host's provisioning               |
| Store          | `/var/lib/superexchange` on the host, mounted at `/data`, owned by the image's `bun`     |
| Crypto store   | `/var/lib/superexchange/crypto/`: back it up with the database                           |
| Listens        | `127.0.0.1:8795`: the homeserver's registration url and the operator's board API         |
| Relay delivery | as `superexchange` on the event relay's network (`treaty_relay`): deploy the relay first |
| Homeserver     | at its public name (`MATRIX_HOMESERVER_URL`), which the container resolves to the host   |
| Deployed tag   | `/etc/superexchange/deployed`                                                            |

`SUPEREXCHANGE_PLAINTEXT_ROOMS` is forced `off` in the production compose file, and the service
refuses it on a homeserver whose name does not start with `staging-` regardless.

## Checks

`bun run check` runs what CI runs: format, typecheck, lint and tests.

## Licence

[MIT](LICENSE)

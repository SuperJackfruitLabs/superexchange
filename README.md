# SuperExchange

The suite's communication server: a Matrix Application Service that carries board work into chat
and the answers back. A gate, a question, a follow-up or a waiting card on a SuperPipeline board
appears in that board's room, and an answer given in chat reaches the board. It takes those
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
tried again at boot and when a person joins. Answers, questions, follow-ups, waiting cards and
the sweeps move here from the AgentPod hub in later steps.

**Nothing is encrypted yet.** Board rooms are end-to-end encrypted, and SuperExchange cannot
encrypt until a later step. Until then it makes and posts into no room at all, unless
`SUPEREXCHANGE_PLAINTEXT_ROOMS=on`, which makes plaintext rooms and is refused on any homeserver
whose server name does not start with `staging-`. It is a staging-only switch, and it is removed
when encryption arrives.

| Route                                                | Who calls it   | What it does                                      |
| ---------------------------------------------------- | -------------- | ------------------------------------------------- |
| `GET /healthz`                                       | anyone         | The health check                                  |
| `PUT /_matrix/app/v1/transactions/:txn`              | the homeserver | Events in, applied once per transaction id        |
| `POST /_matrix/app/v1/ping`                          | the homeserver | `{}`                                              |
| `GET /_matrix/app/v1/users/…`, `rooms/…`             | the homeserver | `M_NOT_FOUND` until rooms move here               |
| `POST /v1/relay/events`                              | the relay      | A signed `gate.pending`, kept for opted-in boards |
| `GET /v1/boards`, `PUT`/`DELETE /v1/boards/:boardId` | the operator   | Opt a board in, disable it, list them             |

## Run it

```sh
bun install
MATRIX_HOMESERVER_URL=http://127.0.0.1:6167 \
MATRIX_SERVER_NAME=example.test \
MATRIX_AS_TOKEN=… MATRIX_HS_TOKEN=… \
TREATY_RELAY_DELIVERY_SECRET=… \
SUPEREXCHANGE_OPERATOR_TOKEN_SHA256=$(printf %s "$OPERATOR_TOKEN" | shasum -a 256 | cut -d' ' -f1) \
SUPEREXCHANGE_DATA_DIR=$PWD/.data \
bun apps/exchange/src/main.ts
curl http://127.0.0.1:8080/healthz
```

| Setting                               | What it is                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `MATRIX_HOMESERVER_URL`               | Where the homeserver's client-server API answers                            |
| `MATRIX_SERVER_NAME`                  | The homeserver's server name                                                |
| `MATRIX_AS_TOKEN`                     | The `as_token` of this appservice's registration                            |
| `MATRIX_HS_TOKEN`                     | The `hs_token` of this appservice's registration                            |
| `TREATY_RELAY_DELIVERY_SECRET`        | The secret the event relay signs its deliveries to this service             |
| `SUPEREXCHANGE_OPERATOR_TOKEN_SHA256` | The SHA-256 (64 hex digits) of the operator's bearer token for `/v1/boards` |
| `SUPEREXCHANGE_DATA_DIR`              | The directory the store's database lives in; `/data` when unset             |
| `PORT`                                | Where it listens; 8080 when unset                                           |
| `SUPEREXCHANGE_PLAINTEXT_ROOMS`       | `on` or `off` (default). Staging only: see Status                           |

A missing or malformed setting stops it before it listens, naming the setting, never its value.

## Checks

`bun run check` runs what CI runs: format, typecheck, lint and tests.

## Licence

[MIT](LICENSE)

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

A scaffold: the service starts, checks its settings and answers a health check. Gate and question
projection, board rooms and their sweeps move here from the AgentPod hub in later steps.

## Run it

```sh
bun install
MATRIX_HOMESERVER_URL=http://127.0.0.1:6167 \
MATRIX_SERVER_NAME=example.test \
MATRIX_AS_TOKEN=… MATRIX_HS_TOKEN=… \
TREATY_RELAY_DELIVERY_SECRET=… \
bun apps/exchange/src/main.ts
curl http://127.0.0.1:8080/healthz
```

| Setting                        | What it is                                                      |
| ------------------------------ | --------------------------------------------------------------- |
| `MATRIX_HOMESERVER_URL`        | Where the homeserver's client-server API answers                |
| `MATRIX_SERVER_NAME`           | The homeserver's server name                                    |
| `MATRIX_AS_TOKEN`              | The `as_token` of this appservice's registration                |
| `MATRIX_HS_TOKEN`              | The `hs_token` of this appservice's registration                |
| `TREATY_RELAY_DELIVERY_SECRET` | The secret the event relay signs its deliveries to this service |
| `PORT`                         | Where it listens; 8080 when unset                               |

A missing or malformed setting stops it before it listens, naming the setting, never its value.

## Checks

`bun run check` runs what CI runs: format, typecheck, lint and tests.

## Licence

[MIT](LICENSE)

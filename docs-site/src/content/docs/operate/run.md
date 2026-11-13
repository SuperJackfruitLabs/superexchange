---
title: Run it
description: What SuperExchange needs from SuperPipeline, the event relay, Accounts and the homeserver, the appservice registration, and how to start it.
---

SuperExchange is one Bun service (Bun 1.2.8, the version in `.bun-version`) with a SQLite store.
It needs four things around it, and refuses to start until every [setting](/operate/settings/) it
needs is present and well formed.

## What it needs

### A Matrix homeserver

- An **appservice registration** for SuperExchange (below), with its own `as_token` and
  `hs_token`, which must differ.
- The homeserver must reach SuperExchange at the registration's `url`, and SuperExchange must reach
  the homeserver's client-server API at `MATRIX_HOMESERVER_URL`.
- **Appservice login** must be on (`io.element.msc4190: false`), and the registration must ask for
  to-device events, device lists and key counts in transactions. See
  [Encryption](/board-chat/encryption/).

### The event relay

[Treaty's relay](https://treaty.superjackfruit.com/relay/) must deliver SuperPipeline's board events to `POST /v1/relay/events`, signed with
the secret SuperExchange holds as `TREATY_RELAY_DELIVERY_SECRET`. SuperExchange subscribes to
`gate.pending`, `elicitation.pending`, `delivery.pending`, `attention.pending` and the seven
board-room notices ([Events carried](/reference/events/)). How the relay delivers, retries and
signs is on [Treaty's relay page](https://treaty.superjackfruit.com/relay/#delivery-and-retries).

### Accounts (the organization plane)

A **service credential** for SuperExchange, `svc_<20 hex>:<secret>`, in the workspace whose boards
it carries. Accounts asserts only members of the credential's own workspace. The credential's
scopes:

| Scope | Used for |
| --- | --- |
| `identities:read` | Who a Matrix sender is (`GET /api/identities/matrix/:mxid`), and the admins' Matrix ids for an escalation |
| `principals:read` | What kind of principal that is, how a receipt names them, and the workspace's owners and admins |
| `token:assert` | The assertion that carries a person's answer to SuperPipeline |
| `gates:read` | The gate, follow-up and waiting-card sweeps, and a card's checks, on SuperPipeline's service routes |
| `approval-requests:relay` | The question sweep (`GET /v1/boards/:boardId/elicitations/pending`) |

`gates:read` and `approval-requests:relay` are SuperPipeline's scopes, carried in the service token
Accounts issues for SuperPipeline's audience. Without one, the sweeps that need it read every board
as unreadable; the relay path and the answers still work.

People must **link their own Matrix id** at Accounts before an answer from them counts. See
[Linking a Matrix id](/operate/linking/).

### SuperPipeline

`SUPERPIPELINE_URL` is SuperPipeline's API: where answers act, what the sweeps read, and the
audience of every assertion and service token. SuperPipeline v0.0.30 or later relays every event
SuperExchange carries and admits its token on every read it makes; an older one degrades as
[Status and limits](/status/) describes.

## The appservice registration

An example, for a homeserver whose server name is `example.test`. The namespaces are exclusive and
anchored at both ends (some homeservers do not anchor registration regexes themselves). They must
not overlap any other appservice's; AgentPod's are `@agent_*` and `#agentpod_*`.

```yaml
id: superexchange
as_token: "<MATRIX_AS_TOKEN>"
hs_token: "<MATRIX_HS_TOKEN>"
url: "http://127.0.0.1:8795"
sender_localpart: superexchange
receive_ephemeral: true
rate_limited: false
namespaces:
  users:
    - exclusive: true
      regex: '^@superexchange_.*:example\.test$'
  aliases:
    - exclusive: true
      regex: '^#superexchange_.*:example\.test$'
  rooms: []
de.sorunome.msc2409.push_ephemeral: true
org.matrix.msc3202: true
io.element.msc4190: false
```

## Start it

From the repository root:

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

`/healthz` answers `{"ok":true,"service":"superexchange"}`. Keep the crypto passphrase: the crypto
store cannot be opened without it.

### What happens at boot

In order: the settings are read and checked, the store is opened (and migrated), the speaker's
encryption is built, and the service listens. Then it gives back any answer a stopped run left
unfinished, queues every card delivered but not yet posted, tries again every encrypted event still
waiting for its key, and starts the sweeps: once now, then every `SUPEREXCHANGE_SWEEP_SECONDS`.

### In a container

`apps/exchange/Dockerfile` builds the service from the repository root
(`docker build -f apps/exchange/Dockerfile .`) on `oven/bun:1.2.8-alpine`: the encryption binding
needs glibc 2.32 or newer, which no Debian image of that Bun has, so it uses the binding's musl
build. The image runs as `bun`, listens on 8795, keeps its store in `/data`, and has a health check
on `/healthz`.

## Then

[Opt a board in](/operate/boards/). Nothing is carried for a board until an operator does.

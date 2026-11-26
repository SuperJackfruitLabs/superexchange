---
title: Settings
description: Every environment variable SuperExchange reads, which are required, their defaults, and the checks it makes before it listens.
---

We give SuperExchange its settings once, at boot, through the environment. A missing or malformed
setting stops it before it listens, and the error names the setting, never its value. Every problem
is listed at once, so one repair pass can clear the whole set.

## Required

| Setting | What it is | Checked |
| --- | --- | --- |
| `MATRIX_HOMESERVER_URL` | Where the homeserver's client-server API answers | An http(s) URL |
| `MATRIX_SERVER_NAME` | The homeserver's server name: the part of a Matrix id after the colon | Set |
| `MATRIX_AS_TOKEN` | The `as_token` of this appservice's registration (sent to the homeserver) | Set; not equal to `MATRIX_HS_TOKEN` |
| `MATRIX_HS_TOKEN` | The `hs_token` of this appservice's registration (sent by the homeserver) | Set |
| `TREATY_RELAY_DELIVERY_SECRET` | The secret the event relay signs its deliveries to this service with | Set |
| `SUPEREXCHANGE_OPERATOR_TOKEN_SHA256` | The SHA-256 of the operator's bearer token for `/v1/boards`, as 64 hex digits. The token itself is never given to the service, so a leaked environment does not leak it | 64 hex digits |
| `ORG_PLANE_URL` | Where the organization plane (Accounts) answers | An http(s) URL |
| `ORG_PLANE_SERVICE_CREDENTIAL` | This service's credential at Accounts. Sent only to Accounts, as a bearer; never logged | `svc_<20 hex digits>:<secret>` |
| `SUPERPIPELINE_URL` | SuperPipeline's API, where answers act and boards are read; also the audience of every assertion and service token | An http(s) URL |
| `SUPEREXCHANGE_CRYPTO_PASSPHRASE` | Encrypts the speaker's crypto store. Used exactly as given, not trimmed | At least 32 characters. Required while plaintext rooms are off |

## Optional

| Setting | Default | What it is |
| --- | --- | --- |
| `SUPEREXCHANGE_DATA_DIR` | `/data` | The directory the store's database (`superexchange.sqlite`) and the crypto store (`crypto/`) live in. Must be an absolute path |
| `PORT` | `8080` (`8795` in the container image) | Where it listens |
| `SUPEREXCHANGE_SWEEP_SECONDS` | `60` | How often the gate, question, follow-up and waiting-card sweeps ask each enabled board, and unposted notices are tried again. Whole seconds from 15 to 86400 |
| `SUPEREXCHANGE_PLAINTEXT_ROOMS` | `off` | `on` makes new rooms without end-to-end encryption. Refused unless `MATRIX_SERVER_NAME` starts with `staging-`. With it on, the crypto passphrase may be unset, and then nothing is encrypted or decrypted |

## superdial's token service

Off unless set. The five below go together: none set, the token service is off and its routes
are 404; some set, the service stops and names the missing ones. The homeserver is the one in
`MATRIX_HOMESERVER_URL` and `MATRIX_SERVER_NAME`. See [HTTP routes](/reference/routes/#superdials-token-service).

| Setting | What it is | Checked |
| --- | --- | --- |
| `LIVEKIT_URL` | LiveKit's public URL, given to callers as `url` | A ws(s) URL |
| `LIVEKIT_API_KEY` | The LiveKit API key tokens are signed under and webhooks are checked against | Set |
| `LIVEKIT_API_SECRET` | That key's secret | Set |
| `SUPERDIAL_HUB_URL` | The AgentPod hub, where `POST /internal/superdial/membership` answers | An http(s) URL |
| `SUPERDIAL_MEMBERSHIP_TOKEN` | The bearer that check takes; sent only to the hub, never logged | Set |
| `LIVEKIT_API_URL` (optional) | LiveKit's server API, for presence checks. Unset: `LIVEKIT_URL` with `wss` read as `https` (`ws` as `http`) | An http(s) URL |

## Making the operator token

The service holds only the hash. Make a token, keep it where operators keep secrets, and give the
service its SHA-256:

```sh
OPERATOR_TOKEN=$(openssl rand -hex 32)
printf %s "$OPERATOR_TOKEN" | shasum -a 256 | cut -d' ' -f1   # SUPEREXCHANGE_OPERATOR_TOKEN_SHA256
```

The printed digest is the setting; the original token is what you present to the operator API. The
service can now authenticate a request without storing the bearer token itself.

The token is presented as `Authorization: Bearer <token>` on
[`/v1/boards`](/operate/boards/).

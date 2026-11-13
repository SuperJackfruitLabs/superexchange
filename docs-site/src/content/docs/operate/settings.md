---
title: Settings
description: Every environment variable SuperExchange reads, which are required, their defaults, and the checks it makes before it listens.
---

SuperExchange reads its settings once, at boot, from the environment. A missing or malformed setting
stops it before it listens, and the error names the setting, never its value. Every problem is
listed at once.

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

## Making the operator token

The service holds only the hash. Make a token, keep it where operators keep secrets, and give the
service its SHA-256:

```sh
OPERATOR_TOKEN=$(openssl rand -hex 32)
printf %s "$OPERATOR_TOKEN" | shasum -a 256 | cut -d' ' -f1   # SUPEREXCHANGE_OPERATOR_TOKEN_SHA256
```

The token is then presented as `Authorization: Bearer <token>` on [`/v1/boards`](/operate/boards/).

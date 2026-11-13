---
title: HTTP routes
description: Every route SuperExchange serves, who calls it, how each is authorised, and what it answers.
---

One dispatcher serves every route. Anything not listed is `404 {"error":"not found"}`.

| Route | Who calls it | Authorised by | What it does |
| --- | --- | --- | --- |
| `GET /healthz` (or `HEAD`) | anyone | nothing | `{"ok":true,"service":"superexchange"}` |
| `PUT /_matrix/app/v1/transactions/:txn` | the homeserver | `hs_token` | Events in, applied once per transaction id |
| `POST /_matrix/app/v1/ping` | the homeserver | `hs_token` | `{}` |
| `GET /_matrix/app/v1/users/…`, `rooms/…` | the homeserver | `hs_token` | `M_NOT_FOUND`: nothing is provisioned on demand |
| `POST /v1/relay/events` | the event relay | the delivery signature | A board event, kept for opted-in boards |
| `GET /v1/boards`, `GET`/`PUT`/`DELETE /v1/boards/:boardId` | the operator | the operator token | Opt a board in, disable it, list them. See [Opt a board in](/operate/boards/) |

## The homeserver's routes

The Application Service API v1. Authorisation is the spec's: `Authorization: Bearer <hs_token>`, or
the legacy `?access_token=` query. No token is `401 M_UNAUTHORIZED`; a wrong one is
`403 M_FORBIDDEN`. Neither says anything else, and no token reaches a log.

**Transactions.** A transaction's crypto parts (to-device events, device-list changes, one-time-key
counts) are handed to the speaker's encryption first, on every delivery, a repeat included: a
retried transaction still carries the current key counts. The events are applied once per
transaction id, recorded in the store before they are handled, so a retry after a crash is not
applied twice. Once authorised, the answer is always `{}`: the homeserver reads anything else as
"not delivered" and retries the whole transaction, so one bad event must not block every one after
it.

## The relay route

Each delivery is a CloudEvent in HTTP binary mode, signed in `x-treaty-signature` over the
timestamp, the event id and the exact body, and checked with treaty's `verifyDelivery` before the
data is read ([how a subscriber verifies](https://treaty.superjackfruit.com/relay/#verifying-a-delivery)).
A body over 256 KiB is refused.

| Delivery | Answer |
| --- | --- |
| Not a CloudEvent | `400`, before the signature is checked (there is no id to check it over) |
| A bad, stale or missing signature | `401` |
| A type SuperExchange does not handle | `200 {"status":"ignored"}`, so the relay does not retry it |
| A body that is not what its type says | `400` |
| A notice whose card was never posted here, or is settled, or a board with no room | `200 {"status":"ignored"}` |
| One for an opted-in, enabled board | Recorded once, `200 {"status":"accepted"}`, and handed on to post (a redelivery too) |
| One for any other board, or an approval request outside this service's workspace | `200 {"status":"ignored"}` |

The types handled are listed in [Events carried](/reference/events/).

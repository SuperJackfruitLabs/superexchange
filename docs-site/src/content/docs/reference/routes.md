---
title: HTTP routes
description: Every route SuperExchange serves, who calls it, how each is authorised, and what it answers.
---

Use this table when you need to know which caller reaches which surface and what proves its
authority. One dispatcher serves every route. Anything not listed is
`404 {"error":"not found"}`.

| Route | Who calls it | Authorised by | What it does |
| --- | --- | --- | --- |
| `GET /healthz` (or `HEAD`) | anyone | nothing | `{"ok":true,"service":"superexchange"}` |
| `PUT /_matrix/app/v1/transactions/:txn` | the homeserver | `hs_token` | Events in, applied once per transaction id |
| `POST /_matrix/app/v1/ping` | the homeserver | `hs_token` | `{}` |
| `GET /_matrix/app/v1/users/…`, `rooms/…` | the homeserver | `hs_token` | `M_NOT_FOUND`: nothing is provisioned on demand |
| `POST /v1/relay/events` | the event relay | the delivery signature | A board event, kept for opted-in boards |
| `GET /v1/boards`, `GET`/`PUT`/`DELETE /v1/boards/:boardId` | the operator | the operator token | Opt a board in, disable it, list them. See [Opt a board in](/operate/boards/) |
| `POST /v1/token` | a call client (superdial) | a Matrix OpenID token, and the hub's membership check | A LiveKit token for that call. Only with the [token service's settings](/operate/settings/#superdials-token-service) |
| `POST /v1/delayed-leave` | a call client (superdial) | the same, and a device of that user | Keeps its delayed leave alive while it is connected |
| `POST /v1/livekit-webhook` | LiveKit | the webhook's signature (the API secret) | Participant and room events for the delayed leaves |

## The homeserver's routes

For homeserver traffic, we follow the Application Service API v1 authentication rules before
reading the request.

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

For relay traffic, we verify the delivery envelope before trusting the event data.

Each delivery is a CloudEvent in HTTP binary mode, signed in `x-treaty-signature` over the
timestamp, the event id and the exact body, and checked with treaty's `verifyDelivery` before the
data is read ([how a subscriber verifies](https://treaty.superjackfruit.com/relay/#verifying-a-delivery)).
A body over 256 KiB is refused.

The answer follows the suite's one receiver status contract
([treaty](https://treaty.superjackfruit.com/relay/)): `2xx` is handled or permanently ignored,
`503` is transient and the relay sends it again, and any other `4xx` is refused for good.

| Delivery | Answer |
| --- | --- |
| Not a CloudEvent | `400`, before the signature is checked (there is no id to check it over) |
| A bad, stale or missing signature | `401` |
| A type SuperExchange does not handle | `200 {"status":"ignored"}`, so the relay does not retry it |
| A body that is not what its type says | `400` |
| A notice for a gate or question delivered here and not yet posted | `503`, so the relay sends it again once its card is up |
| A notice whose card was never posted here, or is settled, or a board with no room | `200 {"status":"ignored"}` |
| One for an opted-in, enabled board | Recorded once, `200 {"status":"accepted"}`, and handed on to post (a redelivery too) |
| One for any other board, or an approval request outside this service's workspace | `200 {"status":"ignored"}` |
| One this service could not handle just now (its store failed) | `503`, so the relay sends it again |

The types handled are listed in [Events carried](/reference/events/).

## superdial's token service

A call client (superdial, in SuperMessage or superdial-agent) trades its Matrix OpenID token for a
LiveKit token here, and hands over its delayed leave so that a client that dies still leaves the
call. The contract is C5 of the superdial plan, held by treaty as
`schemas/http/superexchange/livekit-token.v1`. The routes exist only when the
[token service's settings](/operate/settings/#superdials-token-service) are present.

**Supported homeserver: tuwunel 2.0.0.** The service relies on its OpenID userinfo endpoint,
which it answers with federation off, and its tokenless MSC4140 delayed-event action route.

**Exposure.** Only `/v1/token` and `/v1/delayed-leave` belong under the public name the
homeserver serves as `livekit_url`. LiveKit reaches `/v1/livekit-webhook` on the host or its
network. Nothing else under `/v1/` or `/_matrix/app/` is for the public internet.

### `POST /v1/token`

Request: `{"room_id": "!r:s", "device_id": "DEV", "openid_token": {<the homeserver's OpenID answer>}}`.

1. The OpenID token is checked with the homeserver
   (`GET /_matrix/federation/v1/openid/userinfo?access_token=…`). Only a token whose
   `matrix_server_name` is `MATRIX_SERVER_NAME` is asked about, and only a user of this server is
   accepted back. A user id in the body is never believed.
2. The AgentPod hub is asked whether that user may call in that room
   (`POST {SUPERDIAL_HUB_URL}/internal/superdial/membership`, contract C4).
3. A LiveKit token is minted for identity `{user_id}:{device_id}` in the LiveKit room
   `base64url_nopad(sha256(room_id))`, for that room only: join, publish, subscribe, and set its
   own attributes (superdial-agent shows its call state that way). It is good for 600 s; LiveKit
   refreshes a joined participant's token itself.

| Answer | When |
| --- | --- |
| `200 {"url", "jwt", "identity", "livekit_room"}` | The hub allows the call |
| `403 {"errcode":"M_FORBIDDEN","error":"Calls are not available for this agent yet","reason":…}` | The hub refuses: `not_member`, `not_agent_room`, `harness_mode` or `calls_disabled` |
| `400 M_BAD_JSON` / `M_INVALID_PARAM` | Not a JSON object, or a field that is not what it should be |
| `401 M_UNAUTHORIZED` | The homeserver does not accept the OpenID token, or it is another server's |
| `413` | Over 16 KiB |
| `503 M_UNKNOWN` | The homeserver or the hub cannot answer (a hub that refuses `SUPERDIAL_MEMBERSHIP_TOKEN` included; it is logged) |

Only the `200` and the `403` are contracted; the others are this service's own.

### `POST /v1/delayed-leave`

Request: `{"room_id", "device_id", "delay_id", "openid_token"}`; `204`. The same two checks as
`/v1/token`, and the device must be one the homeserver lists for that user (`keys/query`, asked as
this registration's own user), else `403` with reason `not_your_device`. Then the delay is kept,
by LiveKit room and identity (a new one replaces the old):

- while LiveKit has the identity in the room, the delay is restarted every 3 s:
  `POST /_matrix/client/unstable/org.matrix.msc4140/delayed_events/{delay_id}/restart`, with no
  access token (tuwunel 2.0.0 accepts the delay id as the authority only on this path form). The
  cadence holds whatever is slow: each restart waits on nothing else (not its presence check, not
  another leave's restart) and gives up after 2.5 s, so one failed restart still leaves the next
  inside the 8 s delay;
- it is sent (`…/{delay_id}/send`) and forgotten when LiveKit says the identity's session left
  (`participant_left`) or its connection aborted, when the room finished, when the identity has
  not connected 30 s after it was handed over, or when a presence check finds it gone. Presence
  (LiveKit's server API, 2.5 s timeout) is asked every 3 s until it connects, on the first pass after the service
  starts, and every 30 s while it is connected, so a missed webhook does not keep a call open;
- a session is the participant sid `participant_joined` last named. A rejoin under the same
  identity makes LiveKit remove the old session and say that one left: a leave for another
  session than the known one changes nothing, and one for the known session (or with none known,
  as after a restart of this service) is sent only when LiveKit no longer has the identity, or
  cannot say;
- LiveKit's server API unreachable: a connected identity keeps being restarted, a waiting one is
  sent at 30 s. A delay the homeserver no longer has is forgotten; a send that fails is tried
  again on the next pass.

The leaves are kept in the store (`delayed_leaves`), so a restart of the service resumes them. A
delay id is its holder's authority over that one event: it is kept there and never logged.

### `POST /v1/livekit-webhook`

LiveKit's webhook (`application/webhook+json`), read only when its `Authorization` JWT is signed
with `LIVEKIT_API_SECRET` over this body; `200 {}`, or `401` and nothing changes.

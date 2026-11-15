---
title: Opt a board in
description: The operator's board API. Opting a SuperPipeline board in to SuperExchange, changing its people, disabling it, and moving a board from AgentPod's hub one board at a time.
---

Let's move one board into chat deliberately. SuperExchange carries nothing for it until you opt it
in, and the mapping from board to tenant, workspace, and people lives in SuperExchange's own store;
it is never inferred from anything else.

## The API

Every request carries `Authorization: Bearer <token>`, whose SHA-256 must equal
`SUPEREXCHANGE_OPERATOR_TOKEN_SHA256`. The check is constant-time and comes before the body is
read. A refusal is `401 {"error":"unauthorized"}` and says nothing else.

| Request | Does |
| --- | --- |
| `GET /v1/boards` | Every board, enabled or not: `{ "boards": [ … ] }` |
| `GET /v1/boards/:boardId` | One board: `{ "board": … }`, or 404 |
| `PUT /v1/boards/:boardId` | Opt the board in, or replace its settings, and enable it: `{ "board": … }` |
| `DELETE /v1/boards/:boardId` | Disable it: `{ "board": … }`, or 404. The row stays, so it can be listed and enabled again with a `PUT` |

The service listens where `PORT` says; in production that is loopback only, so the operator calls
it from the host.

### The body of a PUT

```json
{
  "spTenantId": "tnt_…",
  "orgId": "org_…",
  "invitees": ["@ana:example.test", "@ravi:example.test"]
}
```

| Field | What it is | Checked |
| --- | --- | --- |
| `spTenantId` | The board's SuperPipeline tenant | 1 to 128 letters, digits, `_`, `-`, `.` or `:` |
| `orgId` | The board's workspace at Accounts | The same shape |
| `invitees` | The Matrix ids invited to the board's room | A list of at most 50 Matrix user ids (`@localpart:server`); repeats are dropped |

`:boardId` is a SuperPipeline board id: `brd_` and up to 64 letters, digits, `_` or `-`. Anything
else is `400 {"error":"not a board id"}`. A body that is not JSON, or fails a check, is 400 with the
first problem; a body over 64 KiB is refused.

`orgId` matters beyond bookkeeping: approval requests are kept, and escalations invite anyone,
only when it is the workspace of SuperExchange's own service token. `spTenantId` is stored and
listed; nothing in this release acts on it.

### A board, as the API shows it

```json
{
  "boardId": "brd_…",
  "spTenantId": "tnt_…",
  "orgId": "org_…",
  "invitees": ["@ana:example.test"],
  "enabled": true,
  "createdAt": "…",
  "updatedAt": "…"
}
```

### Example

Set the board id in the URL, keep the synthetic ids and Matrix id below replaced with your own,
then send the opt-in:

```sh
curl -sS -X PUT http://127.0.0.1:8795/v1/boards/brd_0123456789abcdef \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"spTenantId":"tnt_…","orgId":"org_…","invitees":["@ana:example.test"]}'
```

The response gives you the enabled board record shown above. That is your receipt that
SuperExchange stored the intended board and invitees.

## What happens next

Nothing visible yet: the room is made when the first card for the board is posted. The next sweep
reads the board's pending gates and questions, and every one SuperExchange has not seen is posted,
so work that was already waiting appears in the new room. See [Board rooms](/board-chat/rooms/).

Your board is now enabled. Its first pending card will create the room; an empty board stays
quiet instead of leaving an empty room behind.

Changing `invitees` with another `PUT` takes effect the next time a card is posted: anyone not yet
joined or invited is invited. Removing someone from the list does not remove them from the room.

Disabling a board stops everything for it: no new card is kept, nothing is posted, and answers in
its room are ignored.

## Moving a board from AgentPod's hub

Until SuperExchange, board chat was spoken by AgentPod's hub. A board moves one at a time, so
exactly one path speaks for each board:

1. **The hub lets go first.** Add the board to its `BOARD_CHAT_MOVED_BOARDS` setting. For those
   boards it no longer
   speaks for. For those it posts nothing, sweeps nothing and ignores answers in the old room, and
   posts one notice there that the board's chat has moved.
   The old path is now quiet before the new one begins.
2. **SuperExchange takes the board**: opt it in with the `PUT` above. The returned board record
   confirms that the new path owns the board.
3. **A new room.** The board gets a new room under SuperExchange's own names. Neither appservice can
   speak in or claim the other's room, so the old room is never taken over.
4. **Nothing waiting is lost.** The sweep posts every pending gate it has not seen, and settles any
   gate decided elsewhere with one receipt.

After those steps, one appservice speaks for the board, the new room has its own identity, and work
that was already waiting still arrives.

A board with no AgentPod fleet needs only steps 2 to 4. Taking a board off the hub's list and
disabling it here returns it to the hub.

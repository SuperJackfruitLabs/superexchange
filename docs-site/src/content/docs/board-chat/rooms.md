---
title: Board rooms
description: One room per opted-in board, made once by SuperExchange's speaker, encrypted, its people invited, and why a card waits for someone to join.
---

Each board SuperExchange carries has one room. Every card, notice and receipt for that board is
said there.

## Names

The names are treaty's, from `boardRoomNames("superexchange")`, inside SuperExchange's exclusive
namespace:

| | Name |
| --- | --- |
| Speaker | `@superexchange_board:<server name>`, display name "superpipeline" |
| Alias | `#superexchange_board_<board id>:<server name>` |
| Room name | The board's name when the event carries it, else the board id |
| Topic | "Approvals for &lt;name&gt;. Answer here and the board hears it." |

The speaker holds power level 100 in its rooms. Because the names are in SuperExchange's own
namespace, a board's room here is never the room AgentPod's hub made for the same board: neither
appservice can speak in or claim the other's room.

## When it is made

The room is made the first time a card for the board is posted, not when the board is opted in.
The speaker is registered and named once per process. If the alias is already taken (an earlier
attempt made the room and did not live to record it), the room behind the alias is the board's
room, and its encryption state is read from the room itself.

A new room is created with `m.room.encryption` (Megolm) in its initial state, unless
`SUPEREXCHANGE_PLAINTEXT_ROOMS` is on (staging only). Whether a room is encrypted is recorded with
it, and a room is never converted. See [Encryption](/board-chat/encryption/).

## Who is invited

The board's `invitees`, as the operator set them when opting the board in (at most 50 Matrix
ids). The first rides on the room's creation; the rest are invited one by one, so one invite the
homeserver refuses does not cost the others their room. Each time a card is posted to an existing
room, any invitee not already joined or invited is invited, so someone added to the board later
is not left out.

An [escalation](/board-chat/notices/) also invites the workspace's owners and admins who have a
linked Matrix id, each once per board.

## The hold: a card waits for a join

A card is held until a **person has joined** the room, not merely been invited. A person is anyone
whose Matrix id does not start with `@superexchange_`. Memberships come from the homeserver's
transactions; when none is on record, the room's joined members are asked once.

Held cards are tried again at boot, when a person joins, and by every sweep.

## What a room will not do

- **Plaintext into an encrypted room:** never, whatever the setting.
- **Speak in a plaintext room while plaintext rooms are off:** nothing is posted there, encrypted
  or not. Getting that board's chat back needs a new room, which is not built yet.
- **Accept answers from elsewhere:** an answer counts only in the board room SuperExchange owns,
  and only when it references a message SuperExchange posted there.

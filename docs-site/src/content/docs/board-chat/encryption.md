---
title: Encryption
description: Board rooms are end-to-end encrypted with SuperExchange's own keys. The speaker's device, the crypto store and its passphrase, what the homeserver registration must allow, and the staging-only plaintext switch.
---

Board rooms are end-to-end encrypted, with SuperExchange's own keys. The speaker,
`@superexchange_board`, has one device and its own crypto store. Encryption uses
`@matrix-org/matrix-sdk-crypto-nodejs`, the Rust state machine, fed what each homeserver
transaction carries.

## The device

The speaker's device is taken **once**, from an appservice login (`m.login.application_service`),
and recorded in the store, so every restart reuses it. A device per boot would leave a trail of
abandoned devices every client must still encrypt to, and throw away every room key the speaker
had been given. The access token that comes with the login is dropped: every request is made as
the appservice.

## The crypto store

The keys live in an on-disk store under `SUPEREXCHANGE_DATA_DIR/crypto/`, encrypted with
`SUPEREXCHANGE_CRYPTO_PASSPHRASE` (at least 32 characters).

:::caution[Back it up with the database]
The crypto store is as load-bearing as the database beside it. Lose it and the speaker loses
every room key it holds, unrecoverably. Lose the passphrase and the store cannot be opened.
:::

A store that is gone while its device is still on record cannot be used with that device (new keys
would not match the ones uploaded), so a new device is taken. A store left without a recorded
device is moved aside, never deleted.

## What is encrypted

A new board room is made with `m.room.encryption` (Megolm) in its initial state. The cards, their
prose, replies and receipts are encrypted to everyone joined or invited: the room key is shared
with everyone joined (read from the homeserver per send, so someone who joined a moment ago is not
missed) and with the people invited and not yet joined, so a card is readable by whoever accepts
the invite next.

## Encrypted answers

A person's encrypted answer is decrypted before it is read. One whose key has not arrived yet
waits in the store, still encrypted, and is tried again whenever keys arrive and at boot. It is
given up after an hour. At most 200 wait at once, so a room whose keys never come cannot grow the
table without end.

## What the homeserver registration needs

SuperExchange's appservice registration must carry:

| Key | Value | Why |
| --- | --- | --- |
| `de.sorunome.msc2409.push_ephemeral` | `true` | To-device events arrive in transactions |
| `org.matrix.msc3202` | `true` | Device-list changes and one-time-key counts arrive in transactions |
| `io.element.msc4190` | `false` | MSC4190 turns appservice login off, and the device comes from that login |

## Plaintext rooms: staging only

`SUPEREXCHANGE_PLAINTEXT_ROOMS=on` makes new rooms in plaintext instead. It is refused on any
homeserver whose server name does not start with `staging-`: the service stops before it listens.
With plaintext rooms on, `SUPEREXCHANGE_CRYPTO_PASSPHRASE` may be unset, and then nothing is
encrypted or decrypted and the encryption binding is never loaded.

A room keeps what it was made as:

- an encrypted room never gets plaintext, whatever the setting;
- a room made in plaintext is left as it is, never converted;
- with the switch off, nothing is posted into a plaintext room, encrypted or not. That board's chat
  comes back only when it is re-opted in for a new room, which is not built yet.

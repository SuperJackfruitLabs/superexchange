---
title: Production and backups
description: How a release reaches production, what it checks and how it rolls back, where the service keeps its state, and what must be backed up together.
---

## How a release deploys

A `vX.Y.Z` tag on `main` deploys production, through the suite's shared release workflow
(`.github/workflows/release.yml`, its settings in `.github/release-config.json`). It runs on the
GitHub mirror only. Only the operator pushes tags. A merge to `main` deploys staging, once the repository's
`STAGING_DEPLOY` variable is `on` (`.github/workflows/staging.yml`).

1. **The gate.** The workflow checks that forge CI passed for the tag's commit, or runs
   `bun run check` at the tag when it cannot read that.
2. **The deploy.** The production host runs that tag's `deploy/production/release.sh` through its
   forced-command deploy key (`superexchange <tag>`). The workflow needs the mirror's `PROD_HOST`
   variable and the `PROD_SSH_KEY` and `PROD_KNOWN_HOSTS` secrets.
3. **The notes.** The release notes go up on GitHub with the tag's section of `CHANGELOG.md`.

## What release.sh does

1. Takes an **online copy of the store** (SQLite's backup API), checked with
   `PRAGMA integrity_check`, before anything changes.
2. Checks out the tag, builds its image (`deploy/production/compose.yml`), and recreates the
   service.
3. Waits up to a minute for `/healthz`, then checks that the service reaches the homeserver
   (`/_matrix/client/versions`, from inside the container).
4. On success, records the tag in the deployed-tag file.
5. **On failure, puts the release before it back.** When the new build had moved the store's
   schema, it first restores the snapshot (keeping the failed database beside it), because a build
   refuses a database written by a newer one. The crypto store is left as it is. If the rollback
   fails too, it says so and stops: the service needs a person.

It refuses to start when the settings file is missing, or when the event relay's network does not
exist (deploy the relay first).

## Where things are

| What | Where |
| --- | --- |
| Settings | `/etc/superexchange/superexchange.env`, written by the host's provisioning |
| Store | `/var/lib/superexchange` on the host, mounted at `/data`, owned by the image's `bun` user |
| Database | `/var/lib/superexchange/superexchange.sqlite` (WAL) |
| Crypto store | `/var/lib/superexchange/crypto/` |
| Listens | `127.0.0.1:8795`: the homeserver's registration `url`, and the operator's board API |
| Relay delivery | as `superexchange` on the event relay's Docker network (`treaty_relay`) |
| Homeserver | at its public name (`MATRIX_HOMESERVER_URL`), which the container resolves to the host |
| Deployed tag | `/etc/superexchange/deployed` |

SuperExchange has no public hostname. The relay reaches it on the relay's network, the homeserver
and the operator on the host's loopback.

`SUPEREXCHANGE_PLAINTEXT_ROOMS` is forced `off` in the production compose file, and the service
refuses it on a homeserver whose name does not start with `staging-` regardless.

## Backups

Three things are backed up, and they belong together:

| What | Why |
| --- | --- |
| The store (`superexchange.sqlite`) | Opted-in boards, rooms and memberships, what was posted and settled, the speaker's device |
| The crypto store (`crypto/`) | The speaker's room keys. Lose it and every key it holds is gone, unrecoverably |
| The settings (`/etc/superexchange`) | The tokens, the operator token's hash, the service credential and the **crypto passphrase**, without which the crypto store cannot be opened |

Take the SQLite files as online snapshots (SQLite's backup API), not as copies of a live file: the
store runs in WAL mode. That includes every SQLite file in the crypto store; its other files can be
copied as they are. The pre-release snapshot `release.sh` takes is for its own rollback, not a
backup.

Restore the store and the crypto store from the same moment. A crypto store that is missing while
its device is still on record cannot be used with that device, so the speaker takes a new one, and
every room key the old one held is gone.

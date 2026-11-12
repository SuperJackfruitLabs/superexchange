#!/usr/bin/env bash
# Deploy a release of SuperExchange to production, as root on the production host: run by the
# host's prod-deploy forced command (`superexchange v<x.y.z>`), which runs this file as it is at
# the tag. Idempotent. Builds the image for the tag, recreates the service, waits for /healthz and
# checks that the service reaches the homeserver. If the new release does not come up healthy,
# the release that was running before is put back.
#
# The store refuses a database written by a newer build, so a rollback across a migration needs
# the database as it was: a snapshot is taken before each release, and put back on rollback when
# the new build moved the schema. The crypto store under crypto/ is left as it is.
set -euo pipefail
tag=${1:?usage: release.sh v<x.y.z>}
repo=/opt/superexchange
etc=/etc/superexchange
env=$etc/superexchange.env
data=/var/lib/superexchange
db=$data/superexchange.sqlite
[ -f "$env" ] || { echo "no $env (the host's provisioning writes it)"; exit 1; }
docker network inspect treaty_relay >/dev/null 2>&1 || { echo "no treaty_relay network: deploy the event relay first"; exit 1; }

# The homeserver's public name, which the container resolves to the host gateway (compose.yml).
hs_url=$(grep '^MATRIX_HOMESERVER_URL=' "$env" | tail -1 | cut -d= -f2-)
SUPEREXCHANGE_HOMESERVER_HOST=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.urlsplit(sys.argv[1]).hostname or "")' "$hs_url")
[ -n "$SUPEREXCHANGE_HOMESERVER_HOST" ] || { echo "MATRIX_HOMESERVER_URL in $env has no host"; exit 1; }
export SUPEREXCHANGE_HOMESERVER_HOST

cd "$repo"
git fetch -q --tags origin
prev=$(cat "$etc/deployed" 2>/dev/null || true)
compose="docker compose -f deploy/production/compose.yml"
snapshot=$data/pre-release.sqlite

# An online copy of the store (SQLite's backup API), or nothing when there is no store yet.
take_snapshot() {
  rm -f "$snapshot"
  [ -f "$db" ] || return 0
  python3 - "$db" "$snapshot" <<'PY'
import sqlite3, sys
from contextlib import closing
with closing(sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)) as live, closing(sqlite3.connect(sys.argv[2])) as copy:
    live.backup(copy)
    assert copy.execute("PRAGMA integrity_check").fetchall() == [("ok",)], "snapshot failed its integrity check"
PY
}

schema_of() {
  python3 -c 'import sqlite3, sys; print(sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True).execute("PRAGMA user_version").fetchone()[0])' "$1"
}

# Called inside `if`, where set -e does not apply, so every step returns on its own failure.
up() {
  git checkout -q --detach "refs/tags/$1" || return 1
  export SUPEREXCHANGE_TAG=$1
  $compose build exchange || return 1
  # The data directory belongs to the user the image runs as.
  owner=$(docker run --rm --entrypoint sh "superexchange:$1" -c 'echo "$(id -u bun):$(id -g bun)"') || return 1
  install -d -m 700 "$data" || return 1
  chown "$owner" "$data" || return 1
  $compose up -d --force-recreate --remove-orphans exchange || return 1
  for _ in $(seq 1 60); do curl -sf http://127.0.0.1:8795/healthz >/dev/null && break; sleep 1; done
  curl -sf http://127.0.0.1:8795/healthz >/dev/null || { $compose logs --tail 50 exchange; return 1; }
  # The homeserver, as the service reaches it.
  $compose exec -T exchange bun -e \
    "fetch(process.env.MATRIX_HOMESERVER_URL + '/_matrix/client/versions').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
    || { echo "superexchange does not reach the homeserver"; return 1; }
}

take_snapshot
if up "$tag"; then
  echo "$tag" > "$etc/deployed"
  echo "released $tag ($(git rev-parse --short HEAD))"
  exit 0
fi
echo "release $tag failed its checks"
if [ -n "$prev" ] && [ "$prev" != "$tag" ]; then
  echo "putting $prev back"
  if [ -f "$snapshot" ] && [ -f "$db" ] && [ "$(schema_of "$db")" != "$(schema_of "$snapshot")" ]; then
    echo "the store's schema moved; restoring the snapshot taken before $tag"
    $compose stop exchange || true
    cp -p "$db" "$db.failed-$tag-$(date -u +%Y%m%dT%H%M%SZ)"
    rm -f "$db-wal" "$db-shm"
    cp "$snapshot" "$db" && chown --reference="$data" "$db"
  fi
  up "$prev" || echo "rollback to $prev failed too; superexchange needs a person"
fi
exit 1

#!/usr/bin/env bash
# Deploy a commit of SuperExchange to the staging plane, as root on the staging host: run by
# /usr/local/sbin/staging-deploy (`superexchange <sha>`, estate provision/301-staging-deploy.sh).
# Idempotent. Builds the image for that commit, recreates the service and waits for its health.
set -euo pipefail
sha=${1:-$(git -C /opt/suite-staging/superexchange rev-parse origin/main)}
cd /opt/suite-staging/superexchange
git fetch -q origin
git checkout -q --detach "$sha"
sha=$(git rev-parse HEAD)

env=/opt/suite-staging/env/superexchange/superexchange.env
[ -f "$env" ] || { echo "no $env (estate provisions it)"; exit 1; }

export SUPEREXCHANGE_SHA=$sha
compose="docker compose -f deploy/staging/compose.yml"
$compose build exchange
$compose up -d --force-recreate --remove-orphans exchange
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8795/healthz >/dev/null; then
    git log -1 --format='staged %h %s'
    exit 0
  fi
  sleep 1
done
echo "superexchange did not answer /healthz; its log:"
$compose logs --tail 50 exchange
exit 1

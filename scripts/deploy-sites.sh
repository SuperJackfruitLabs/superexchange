#!/usr/bin/env bash
# Build superexchange.dev and deploy it as a Cloudflare Worker with static assets.
#
# CI runs it on every merge to main that touches the site (.github/workflows/sites.yml, on the
# GitHub mirror), with the organisation's CLOUDFLARE_API_TOKEN. It also runs by hand with a
# `wrangler login`. landing/wrangler.jsonc names the Worker and its custom domains, so this
# attaches the domains too.
#
# --config is explicit and wrangler runs from a scratch directory: in a site directory without a
# config, wrangler's project detection scaffolds an adapter into the site and rewrites
# astro.config.mjs (other products learned this against the live account).
#
# Usage: scripts/deploy-sites.sh [landing]   (default: landing, the only site)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
which="${1:-landing}"
case "$which" in landing|all) ;; *) echo "usage: $0 [landing]" >&2; exit 2 ;; esac

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

echo "==> building landing"
(cd "$root/landing" && npm ci && npm run build)
echo "==> deploying landing -> https://superexchange.dev"
(cd "$scratch" && npx --yes wrangler@4 deploy --config "$root/landing/wrangler.jsonc")
echo "==> landing deployed: https://superexchange.dev"

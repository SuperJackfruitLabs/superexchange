#!/usr/bin/env bash
# Build superexchange.dev and docs.superexchange.dev and deploy each as a Cloudflare Worker with
# static assets.
#
# CI runs it on every merge to main that touches a site (.github/workflows/sites.yml, on the
# GitHub mirror), with the organisation's CLOUDFLARE_API_TOKEN. It also runs by hand with a
# `wrangler login`. Each site's wrangler.jsonc names its Worker and its custom domains, so this
# attaches the domains too.
#
# --config is explicit and wrangler runs from a scratch directory: in a site directory without a
# config, wrangler's project detection scaffolds an adapter into the site and rewrites
# astro.config.mjs (other products learned this against the live account).
#
# Usage: scripts/deploy-sites.sh [landing|docs|all]   (default: all)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
which="${1:-all}"
case "$which" in landing|docs|all) ;; *) echo "usage: $0 [landing|docs|all]" >&2; exit 2 ;; esac

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

ship() { # <dir> <url>
  echo "==> building $1"
  (cd "$root/$1" && npm ci && npm run build)
  echo "==> deploying $1 -> $2"
  (cd "$scratch" && npx --yes wrangler@4 deploy --config "$root/$1/wrangler.jsonc")
  echo "==> $1 deployed: $2"
}

if [ "$which" = landing ] || [ "$which" = all ]; then ship landing "https://superexchange.dev"; fi
if [ "$which" = docs ] || [ "$which" = all ]; then ship docs-site "https://docs.superexchange.dev"; fi

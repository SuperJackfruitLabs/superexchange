#!/bin/sh
set -eu

classify() {
  files=$1
  docs_only=false
  app=true
  sites=true

  if [ -n "$files" ]; then
    sites=false
    docs='^(README$|README\.(md|markdown|txt|rst)$|docs/|docs-site/)'
    site='^(landing/|docs-site/|scripts/deploy-sites\.sh$|\.github/workflows/sites\.yml$)'

    other=$(printf '%s\n' "$files" | grep -vE "$docs" | grep -v '^$' || true)
    [ -z "$other" ] && { docs_only=true; app=false; }
    printf '%s\n' "$files" | grep -qE "$site" && sites=true
    printf '%s\n' "$files" | grep -qE '^\.(forgejo|github)/' && sites=true
  fi

  printf 'docs_only=%s\napp=%s\nsites=%s\n' "$docs_only" "$app" "$sites"
}

if [ "${1:-}" = --classify ]; then
  classify "$(cat)"
  exit
fi

base=''
if [ "${EVENT:-}" = pull_request ]; then
  base=$(git merge-base "${PR_BASE:-}" HEAD 2>/dev/null || true)
fi
if [ "${EVENT:-}" = push ] && [ -n "${BEFORE:-}" ] && ! printf %s "$BEFORE" | grep -qE '^0+$'; then
  base=$BEFORE
fi

files=''
if [ -n "$base" ]; then
  files=$(git diff --name-only "$base" HEAD 2>/dev/null) || files=''
fi

classify "$files"
printf 'base=%s\n' "${base:-none}" >&2

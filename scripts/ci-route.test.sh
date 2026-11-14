#!/bin/sh
set -eu

route=./scripts/ci-route.sh

expect() {
  want=$1
  name=$2
  files=$3
  got=$(printf '%s' "$files" | "$route" --classify)
  if [ "$got" != "$want" ]; then
    printf 'not ok - %s\nwant: %s\n got: %s\n' "$name" "$want" "$got" >&2
    exit 1
  fi
  printf 'ok - %s\n' "$name"
}

docs='docs_only=true
app=false
sites=false'
docs_site='docs_only=true
app=false
sites=true'
full='docs_only=false
app=true
sites=false'
full_sites='docs_only=false
app=true
sites=true'

expect "$docs" 'root README without an extension' 'README
'
expect "$docs" 'allowed root README extensions' 'README.md
README.markdown
README.txt
README.rst
'
expect "$docs" 'docs tree' 'docs/code-quality.md
'
expect "$docs_site" 'docs-site tree' 'docs-site/src/content/docs/index.mdx
'
expect "$docs_site" 'mixed documentation paths remain docs-only' 'README.md
docs/guide.md
docs-site/src/content/docs/index.mdx
'
expect "$full" 'other README suffixes are not docs-only' 'README.adoc
'
expect "$full" 'README backups are not docs-only' 'README.md.bak
'
expect "$full" 'a nested README outside docs is application work' 'apps/exchange/README.md
'
expect "$full" 'root package and lock changes are application work' 'package.json
bun.lock
'
expect "$full" 'documentation mixed with code runs full CI' 'docs/guide.md
apps/exchange/src/main.ts
'
expect "$full_sites" 'landing changes run full CI and site builds' 'landing/src/index.ts
'
expect "$full_sites" 'workflow changes run every check' '.forgejo/workflows/ci.yml
'
expect "$full_sites" 'an empty or unknown change set runs every check' ''

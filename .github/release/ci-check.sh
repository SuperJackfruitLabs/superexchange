#!/bin/sh
# Release hook (ci-check): the gate's fallback when forge CI's result for the tag cannot be read: what forge CI runs.
# The shared release workflow runs this file, at a fixed path, when it exists.
set -eu
bun install --frozen-lockfile && bun run check

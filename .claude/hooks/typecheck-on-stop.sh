#!/usr/bin/env bash
# Stop hook: when the turn left TypeScript changes, run the type check and hand errors back to Claude.
set -euo pipefail

input=$(cat)
# A stop that this hook already blocked once: let it end, so a stuck error cannot loop.
printf '%s' "$input" | grep -q '"stop_hook_active": *true' && exit 0

cd "${CLAUDE_PROJECT_DIR:-.}"
git status --porcelain -- 'src/*.ts' 'test/*.ts' 'scripts/*.mjs' | grep -q . || exit 0

if ! output=$(npm run --silent typecheck 2>&1); then
  printf 'Type check failed:\n%s\n' "$(printf '%s' "$output" | head -40)" >&2
  exit 2
fi

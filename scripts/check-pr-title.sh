#!/usr/bin/env bash
# Usage: check-pr-title.sh "<title>". Shared by CI and the Claude Code hook that guards gh pr create/edit.
set -euo pipefail

title=${1-}
pattern='^(feat|fix|perf|refactor|docs|revert|chore|style|test|build|ci)\([a-z0-9._/-]+\)!?: [^A-Z]'
if ! [[ "$title" =~ $pattern ]]; then
  echo "${GITHUB_ACTIONS:+::error::}PR title must be <type>(<scope>): <lowercase subject>, got: $title" >&2
  exit 1
fi

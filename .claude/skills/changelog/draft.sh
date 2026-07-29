#!/usr/bin/env bash
# Draft a CHANGELOG entry via git-cliff.
#
# Usage:
#   draft.sh [<from-ref>]
#
# Single-package repo: drafts span the whole tree. With no <from-ref> the
# range starts at the last release tag (`v*`); if no tag exists yet, all of
# history is in range.
#
# Emits Keep-a-Changelog sections (### Added / ### Changed / ### Fixed) on
# stdout, or the no-changes sentinel — the /changelog skill captures and
# curates the output.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SENTINEL="_No user-facing changes._"

from_ref="${1:-}"

if ! command -v git-cliff >/dev/null 2>&1; then
  cat >&2 <<'EOF'
git-cliff not found. Install with one of:

  brew install git-cliff
  cargo install git-cliff
  npm install -g git-cliff

Then re-run.
EOF
  exit 127
fi

if [[ -z "$from_ref" ]]; then
  from_ref="$(git describe --tags --match 'v*' --abbrev=0 2>/dev/null || true)"
fi

args=(--config cliff.toml --strip all)
# No range when nothing has shipped -> git-cliff spans all of history.
[[ -n "$from_ref" ]] && args+=("${from_ref}..HEAD")

out=$(git-cliff "${args[@]}" 2>/dev/null || true)
if [ -z "$(echo "$out" | tr -d '[:space:]')" ]; then
  echo "$SENTINEL"
else
  echo "$out"
fi

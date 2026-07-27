#!/usr/bin/env bash
# One command for the whole suite.
#
#   ./tests/run.sh          both tiers
#   ./tests/run.sh tier1    structural only — no npm, no browser, ~0.1 s
#   ./tests/run.sh tier2    browser smoke test — needs `npm install` in tests/
#
# The site itself stays dependency-free: nothing is installed at the repo root,
# and tier 1 runs on a bare Node with no packages at all.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIER="${1:-all}"

run_tier1() {
  echo "── tier 1: structural (node --test, zero dependencies) ───────────────"
  cd "$HERE"
  node --test "tier1/*.test.js"
}

run_tier2() {
  echo
  echo "── tier 2: browser smoke test (Playwright + python3 -m http.server) ──"
  cd "$HERE"
  if [ ! -d node_modules/@playwright ]; then
    echo "Installing test dependencies in tests/ (nothing is added to the repo root)…"
    npm install --no-audit --no-fund
    npx playwright install chromium
  fi
  npx playwright test "$@"
}

case "$TIER" in
  tier1) run_tier1 ;;
  tier2) shift; run_tier2 "$@" ;;
  all)   run_tier1; run_tier2 ;;
  *)     echo "usage: $0 [tier1|tier2]" >&2; exit 2 ;;
esac

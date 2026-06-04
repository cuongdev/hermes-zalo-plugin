#!/usr/bin/env bash
# install.sh — Hermes Zalo bridge installer for macOS / Linux.
# Thin wrapper: verifies Node is present, then hands off to install.mjs
# (which does deps → QR login → background service, cross-platform).
#
#   ./install.sh                # full setup
#   ./install.sh --no-service   # skip the auto-start service
#   ./install.sh --relogin      # force a fresh QR login
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is required but not found."
  echo "  Install Node >= 18 from https://nodejs.org (or your package manager), then re-run."
  exit 1
fi

exec node install.mjs "$@"

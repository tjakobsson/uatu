#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$ROOT/tests/fixtures/swift-openapi-smoke"
CONTRACT="$ROOT/api/openapi.yaml"

if ! command -v swift >/dev/null 2>&1; then
  echo "error: Swift is required to verify OpenAPI generation" >&2
  exit 1
fi

if [[ ! -f "$CONTRACT" ]]; then
  echo "error: canonical contract not found at $CONTRACT" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/uatu-swift-openapi.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

cp -R "$FIXTURE/." "$WORK/"
cp "$CONTRACT" "$WORK/Sources/SmokeClient/openapi.yaml"

swift build --package-path "$WORK"
echo "Swift OpenAPI generation and compilation succeeded"

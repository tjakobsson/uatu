#!/usr/bin/env bash
# Build the working tree and install UatuCode Desktop into /Applications
# for local dogfooding. macOS only by nature — it drives xcodebuild. The
# result is ad-hoc signed, which is fine on the machine that built it.
set -euo pipefail

cd "$(dirname "$0")/.."

if pgrep -f "/Applications/UatuCode Desktop.app/Contents/MacOS/" > /dev/null; then
  echo "UatuCode Desktop is running — quit it first, then re-run this script." >&2
  exit 1
fi

echo "==> Building uatu CLI (bun run build)"
bun install --frozen-lockfile
bun run build

base="$(bun -e 'console.log(require("./package.json").version)')"
version="$base-local.$(git rev-parse --short HEAD)"

echo "==> Building UatuCode Desktop $version"
xcodebuild \
  -project desktop/macos/UatuCodeDesktop.xcodeproj \
  -scheme UatuCodeDesktop \
  -configuration Release \
  -derivedDataPath desktop/macos/build-local \
  UATU_BINARY="$PWD/dist/uatu" \
  MARKETING_VERSION="$version" \
  build

app="desktop/macos/build-local/Build/Products/Release/UatuCode Desktop.app"

# Recheck right before deleting: the build takes minutes, plenty of time
# for the app to have been launched since the check at the top.
if pgrep -f "/Applications/UatuCode Desktop.app/Contents/MacOS/" > /dev/null; then
  echo "UatuCode Desktop was started while building — quit it, then re-run this script." >&2
  exit 1
fi

echo "==> Installing into /Applications"
rm -rf "/Applications/UatuCode Desktop.app"
ditto "$app" "/Applications/UatuCode Desktop.app"

echo "Installed UatuCode Desktop $version to /Applications"

#!/usr/bin/env bash
# Install Playwright's system libraries on an Ubuntu runner, each attempt
# bounded and retried by retry-bounded.sh.
#
# - Everything runs as root. Otherwise Playwright reaches apt-get through
#   sudo, where the runner user's timeout cannot stop it. PATH is passed on so
#   root finds bun. install-deps runs only apt and writes no browser files.
# - Dpkg::Use-Pty is off: with it, apt starts dpkg in a new session, outside
#   the process group a failed attempt's cleanup kills.
# - Each attempt first runs `dpkg --configure -a`, because apt refuses to
#   install after a killed attempt interrupted dpkg. It is a no-op otherwise,
#   and best effort: even when it fails it has cleared what made apt refuse,
#   and apt can then reinstall a package left half-unpacked.
# - Run it with `exec` from the step, so the step's process ends up as sudo,
#   which passes a cancellation on to retry-bounded.sh.
#
# Usage: install-playwright-deps.sh <browser>...
set -eu

echo 'Dpkg::Use-Pty "0";' | sudo tee /etc/apt/apt.conf.d/90playwright-no-pty >/dev/null
exec sudo env "PATH=$PATH" "$(dirname "$0")/retry-bounded.sh" \
  sh -c 'dpkg --configure -a; exec bunx playwright install-deps "$@"' sh "$@"

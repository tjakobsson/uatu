#!/usr/bin/env bash
# Run a command with a per-attempt time limit and a small number of retries.
#
# Used for the Playwright system-dependency installs, whose apt calls can stall
# on a slow mirror for most of a job's time limit. A stalled attempt is killed
# and retried instead of being left to run until the job is cancelled.
#
# Usage: retry-bounded.sh <command> [args...]
# Tuning (environment): RETRY_ATTEMPTS (3), RETRY_TIMEOUT seconds (180),
# RETRY_PAUSE seconds between attempts (10).
set -u

attempts=${RETRY_ATTEMPTS:-3}
limit=${RETRY_TIMEOUT:-180}
pause=${RETRY_PAUSE:-10}

for ((attempt = 1; attempt <= attempts; attempt++)); do
  timeout --kill-after=15 "$limit" "$@" && exit 0
  status=$?
  echo "::warning::attempt $attempt of $attempts failed (exit $status): $*"
  if ((attempt < attempts)); then
    sleep "$pause"
  fi
done

echo "::error::all $attempts attempts failed: $*"
exit 1

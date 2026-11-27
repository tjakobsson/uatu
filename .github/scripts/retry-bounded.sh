#!/usr/bin/env bash
# Run a command with a per-attempt time limit and a small number of retries.
#
# Used for the Playwright system-dependency installs, whose apt calls can stall
# on a slow mirror for most of a job's time limit. A stalled attempt is killed
# and retried instead of being left to run until the job is cancelled.
#
# `timeout` leads its own process group. After a failed attempt the whole group
# is killed, so no process from it (an apt-get still holding the apt lock, say)
# outlives the attempt. Signals reach only processes of the same user: run this
# script as root when the command escalates with sudo.
#
# Usage: retry-bounded.sh <command> [args...]
# Tuning (environment): RETRY_ATTEMPTS (3), RETRY_TIMEOUT seconds (180),
# RETRY_PAUSE seconds between attempts (10).
set -u

attempts=${RETRY_ATTEMPTS:-3}
limit=${RETRY_TIMEOUT:-180}
pause=${RETRY_PAUSE:-10}

# A cancellation signals this script, not timeout's group: clear the group too.
# $! is set the moment an attempt starts, before `group=$!` runs. The pid goes
# first: a timeout killed before making its group has forked nothing, and once
# it is dead it can fork nothing more, so the group sweep that follows catches
# any command it did start.
trap 'kill -KILL -- "${!:-}" "-${!:-}" 2>/dev/null; exit 143' TERM INT

for ((attempt = 1; attempt <= attempts; attempt++)); do
  # In the background so its pid, which is the group id, is known; <&0 keeps
  # stdin, which a background command would otherwise lose to /dev/null.
  timeout --kill-after=15 "$limit" "$@" <&0 &
  group=$!
  wait "$group" && exit 0
  status=$?
  kill -KILL -- "-$group" 2>/dev/null
  echo "::warning::attempt $attempt of $attempts failed (exit $status): $*"
  if ((attempt < attempts)); then
    sleep "$pause"
  fi
done

echo "::error::all $attempts attempts failed: $*"
exit 1

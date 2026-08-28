## Context

See `proposal.md` for motivation. The SSH guardian currently commits a mode-0600 version-2 ownership record containing a nonce, diagnostic PIDs, and exact identities for its agent and control sockets. Recovery authenticates a stop request over the control socket and deliberately never reconstructs or signals recorded PIDs. This protects unrelated same-UID processes and sockets, but an abrupt WSL2 VM shutdown leaves persistent socket directory entries with no process available to answer that request.

Linux exposes a per-boot UUID at `/proc/sys/kernel/random/boot_id`. A different boot UUID proves that no process from the recorded boot can still be running, while the existing socket identities prove which remaining paths belong to that guardian.

## Goals / Non-Goals

**Goals:**

- Make future WSL2 and Linux reboot remnants recover automatically without weakening current-boot ownership checks.
- Recover when either both sockets remain or shutdown removed only one of them.
- Keep shipped version-2 records readable during upgrades.
- Make failures that cannot be recovered automatically tell an operator how to recover safely.

**Non-Goals:**

- Infer ownership from recorded PIDs or signal those PIDs during Hub recovery.
- Automatically delete version-2 or current-boot state when guardian authentication fails.
- Change stored SSH keys, credential metadata, public APIs, or non-Linux agent behavior.

## Decisions

### Persist boot identity in ownership version 3

On Linux, the manager reads and validates `/proc/sys/kernel/random/boot_id`, passes it through a versioned private startup message, and the guardian includes it in a version-3 ownership record. If no valid boot identity is available, the guardian continues to use version 2 and recovery remains fail-closed.

The parser accepts both exact version-2 and exact version-3 shapes. This preserves access to a live guardian created by the shipped format and avoids treating an optional unversioned field as valid in ambiguous records.

Alternatives considered:

- Checking whether recorded PIDs exist was rejected because the design treats PIDs as diagnostic-only and PID reuse does not establish process identity.
- Comparing file modification time with boot time was rejected because wall-clock corrections can make that comparison unreliable.
- Deleting any socket that refuses a connection was rejected because a live but delayed guardian or replaced socket must remain fail-closed.

### Clean only exact artifacts from a different boot

Recovery takes the automatic path only when both the record and current environment provide valid, different Linux boot IDs. Every socket that still exists is atomically renamed to its nonce-specific quarantine path, then must pass the existing owner, mode, type, device, and inode checks against the record before unlinking. Missing sockets are accepted because abrupt shutdown may interrupt normal cleanup. The ownership record is quarantined and revalidated after the sockets, then removed last so an interrupted recovery can retry from the same proof.

No numeric PID is signaled. Current-boot records continue through authenticated guardian control, and any identity mismatch aborts cleanup.

### Keep legacy recovery explicit

A version-2 record has no proof that it predates the current boot, so it retains existing authenticated recovery semantics. Generic guardian request failures gain instructions to restart the Hub and, only after confirming no managed guardian or agent remains, remove the credential runtime directory. Once a fresh Linux guardian starts under the new version, subsequent reboot recovery is automatic.

## Risks / Trade-offs

- [The Linux boot ID is unavailable or malformed] -> Emit version 2 and preserve existing fail-closed behavior with actionable guidance.
- [An upgrade encounters a stale version-2 record] -> Require one manual recovery; all fresh Linux records use version 3 afterward.
- [Cleanup is interrupted after removing one socket] -> Keep the ownership record until last and allow missing recorded sockets on the next previous-boot recovery attempt.
- [A socket path is replaced before recovery] -> Recheck exact socket identity immediately before removal and preserve mismatched state.
- [Rolling back while a version-3 guardian record exists] -> The older binary rejects the unsupported record with whole-runtime manual recovery guidance; credential secrets remain outside the runtime directory.

## Migration Plan

1. Deploy the new binary without rewriting existing runtime state.
2. Recover live version-2 guardians through their existing authenticated control channel.
3. Write version-3 records when a fresh guardian starts on Linux with a valid boot ID.
4. On rollback, stop the Hub gracefully first so the current guardian removes its runtime record. If that is impossible, follow the existing whole-runtime manual recovery procedure after confirming the managed processes are gone.

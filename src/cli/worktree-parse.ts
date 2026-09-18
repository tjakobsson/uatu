// `uatu worktree …` — argument parsing and usage text (task 6.1's CLI half).
//
// Side-effect-free, like the rest of `src/cli/`: the unit suite parses
// argument vectors directly and the entrypoint owns all process wiring.
//
// Two rules shape every decision here:
//
//   * Reject before requesting. An option-like value, an invalid branch
//     grammar, a missing mode or an unknown flag fails locally, so nothing
//     that cannot possibly be a valid operation ever reaches the Hub — and
//     nothing option-shaped can be smuggled toward a Git argument list.
//   * Never invent a destination, a base, or a confirmation. `create` takes
//     exactly one of the three approved modes; the Hub computes the sibling
//     destination. `remove` requires an explicit confirmation flag. There is
//     no force flag and no branch deletion anywhere in this surface.

import { validWorktreeBranch } from "../shared/worktree-branches";
import type { WorktreeCreateMode, WorktreeRefSelection } from "../shared/worktree-contract";

export type WorktreeCommand =
  | { readonly kind: "help" }
  | { readonly kind: "list"; readonly json: boolean }
  | {
    readonly kind: "create";
    readonly json: boolean;
    readonly start: boolean;
    readonly mode: WorktreeCreateMode;
    readonly branch?: string;
    // An exactly committed selection, for the two modes where the flag
    // itself says whether the ref is local or remote.
    readonly base?: WorktreeRefSelection;
    // `--from`'s ref, left UNRESOLVED on purpose: "feature/login" is a
    // perfectly good local branch name, so only the repository's own ref
    // listing can say whether a slashed ref is local or remote-qualified.
    // The Hub resolves it against that authoritative listing; the CLI does
    // not guess, and does not read a repository to find out.
    readonly baseRef?: string;
  }
  | { readonly kind: "open"; readonly json: boolean; readonly start: boolean; readonly reference: string }
  | { readonly kind: "remove"; readonly json: boolean; readonly stop: boolean; readonly reference: string };

export function worktreeUsageText(): string {
  return `Usage:
  uatu worktree list [--json]
  uatu worktree create --new-branch <NAME> --from <REF> [--start] [--json]
  uatu worktree create --branch <LOCAL-BRANCH> [--start] [--json]
  uatu worktree create --remote-branch <REMOTE>/<BRANCH> [--start] [--json]
  uatu worktree open <BRANCH|WORKSPACE-ID> [--start] [--json]
  uatu worktree remove <BRANCH|WORKSPACE-ID> --confirm-delete [--stop] [--json]

Creates and manages Git worktrees of the workspace you are in as ordinary
Uatu workspaces. Every operation is performed by the Hub, through the same
authoritative service and the same safety rules its own interface uses; this
command runs no Git of its own and has no offline fallback.

It needs the Hub context the workspace's terminal already carries. Run it
inside an Uatu workspace terminal; there is nothing to configure and no
credential to pass.

Commands:
  list      The repository's checkouts, their branches and whether each runs
  create    Add a linked worktree. The Hub picks the sibling destination
            <main-folder>.worktrees/<branch>; there is no destination option
  open      Report where an existing checkout is, and with --start, start it
  remove    Delete a worktree Uatu created, after every safety check. The
            branch is always kept; there is no force and no branch deletion

Options:
  --new-branch <NAME>       Create NAME, based on --from
  --from <REF>              The starting ref for --new-branch: a local branch,
                            or a remote-qualified one such as origin/main
  --branch <LOCAL-BRANCH>   Check out an existing local branch
  --remote-branch <REF>     Create a local tracking branch from a remote ref
  --start                   Start the workspace after the operation
  --stop                    Authorize stopping this worktree's own Uatu
                            sessions before deleting it
  --confirm-delete          Required by remove. The confirmation IS the
                            authorization; no blocker can be forced past it
  --json                    Structured JSON result instead of readable text
  -h, --help                Show this help

Exit codes: 0 success, 1 the operation was refused, 2 invalid usage,
3 no usable Hub context.
`;
}

const CREATE_MODE_FLAGS = ["--new-branch", "--branch", "--remote-branch"] as const;

function optionLike(value: string): boolean {
  return value.startsWith("-");
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new Error(`missing value for ${flag}`);
  // An option-shaped value is always a mistake here, and refusing it is what
  // keeps `--new-branch --from` from silently creating a branch named
  // "--from" — or from reaching Git as a flag.
  if (optionLike(value)) throw new Error(`${flag} expects a value, not another option`);
  return value;
}

function requireBranch(flag: string, value: string): string {
  if (!validWorktreeBranch(value)) throw new Error(`${flag} is not a valid branch name: ${value}`);
  return value;
}

// A remote-qualified ref: "<remote>/<branch>", both halves valid, neither
// empty. The remote prefix is dropped by the Hub to derive the local
// tracking name, so this is the one place the shape must be checked.
function requireRemoteRef(flag: string, value: string): string {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${flag} expects a remote-qualified branch such as origin/main`);
  }
  requireBranch(flag, value.slice(0, separator));
  requireBranch(flag, value.slice(separator + 1));
  return value;
}

export function parseWorktreeCommand(argv: readonly string[]): WorktreeCommand {
  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === "-h" || subcommand === "--help") return { kind: "help" };
  if (!["list", "create", "open", "remove"].includes(subcommand)) {
    throw new Error(`unknown worktree command: ${subcommand}`);
  }

  let json = false;
  let start = false;
  let stop = false;
  let confirmDelete = false;
  let newBranch: string | undefined;
  let from: string | undefined;
  let existingBranch: string | undefined;
  let remoteBranch: string | undefined;
  const positional: string[] = [];

  const rest = argv.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--start") {
      start = true;
      continue;
    }
    if (arg === "--stop") {
      stop = true;
      continue;
    }
    if (arg === "--confirm-delete") {
      confirmDelete = true;
      continue;
    }
    if (arg === "--new-branch" || arg === "--from" || arg === "--branch" || arg === "--remote-branch") {
      const value = requireValue(arg, rest[index + 1]);
      index += 1;
      if (arg === "--new-branch") newBranch = requireBranch(arg, value);
      else if (arg === "--branch") existingBranch = requireBranch(arg, value);
      else if (arg === "--remote-branch") remoteBranch = requireRemoteRef(arg, value);
      else from = value;
      continue;
    }
    if (optionLike(arg)) throw new Error(`unknown option: ${arg}`);
    positional.push(arg);
  }

  if (subcommand === "list") {
    if (positional.length > 0) throw new Error("worktree list takes no arguments");
    for (const [flag, used] of [["--start", start], ["--stop", stop], ["--confirm-delete", confirmDelete]] as const) {
      if (used) throw new Error(`${flag} does not apply to worktree list`);
    }
    if (newBranch ?? from ?? existingBranch ?? remoteBranch) throw new Error("worktree list takes no branch options");
    return { kind: "list", json };
  }

  if (subcommand === "create") {
    if (positional.length > 0) {
      throw new Error("worktree create takes no positional arguments; name the branch with --new-branch, --branch or --remote-branch");
    }
    if (stop) throw new Error("--stop does not apply to worktree create");
    if (confirmDelete) throw new Error("--confirm-delete does not apply to worktree create");
    const chosen = CREATE_MODE_FLAGS.filter((_, position) => [newBranch, existingBranch, remoteBranch][position] !== undefined);
    if (chosen.length === 0) throw new Error("worktree create needs one of --new-branch, --branch or --remote-branch");
    if (chosen.length > 1) throw new Error(`worktree create takes one of ${CREATE_MODE_FLAGS.join(", ")}, not ${chosen.join(" and ")}`);
    if (newBranch !== undefined) {
      if (from === undefined) throw new Error("--new-branch needs --from <REF> naming its starting branch");
      return { kind: "create", json, start, mode: "new-branch", branch: newBranch, baseRef: requireBranch("--from", from) };
    }
    if (from !== undefined) throw new Error("--from applies only to --new-branch");
    if (existingBranch !== undefined) {
      return { kind: "create", json, start, mode: "existing-local", base: { kind: "local", ref: existingBranch } };
    }
    return { kind: "create", json, start, mode: "remote-tracking", base: { kind: "remote", ref: remoteBranch! } };
  }

  if (newBranch ?? from ?? existingBranch ?? remoteBranch) {
    throw new Error(`worktree ${subcommand} takes no branch options; name the worktree as an argument`);
  }
  if (positional.length === 0) throw new Error(`worktree ${subcommand} needs the branch or workspace id of a worktree`);
  if (positional.length > 1) throw new Error(`worktree ${subcommand} takes exactly one worktree`);
  const reference = positional[0]!;

  if (subcommand === "open") {
    if (stop) throw new Error("--stop does not apply to worktree open");
    if (confirmDelete) throw new Error("--confirm-delete does not apply to worktree open");
    return { kind: "open", json, start, reference };
  }

  if (start) throw new Error("--start does not apply to worktree remove");
  if (!confirmDelete) {
    throw new Error("worktree remove needs --confirm-delete; nothing was removed");
  }
  return { kind: "remove", json, stop, reference };
}

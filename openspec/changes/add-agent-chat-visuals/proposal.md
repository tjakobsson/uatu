# Proposal

## Why

Agents need to show diagrams and screenshots where users are already reading
their replies. [Issue #544](https://github.com/tjakobsson/uatu/issues/544)
asks for inline SVG, PNG, and JPEG, with original SVG source and existing
security protections preserved.

This proposal records the agreed scope retrospectively: implementation and a
first review round already exist. It is an approval checkpoint, not a claim
that proposal-first development occurred or that verification is complete.

## What Changes

- Render explicit Markdown images and fenced SVG in assistant replies during
  streaming, with in-chat enlargement and accessible source/copy controls.
- Persist the first capture of each logical occurrence independently of its
  source file, provider streaming IDs, and HTML layout repair.
- Preserve workspace file-access rules, block automatic external resource
  loading, and handle refused or unavailable images without breaking chat.
- Bound assistant visuals to 10 MiB each and eight per message; leave user
  attachment formats and policy unchanged.
- Supply scoped native presentation guidance to managed Claude Code and
  OpenCode sessions without changing prompts, permissions, or user configuration.
- **BREAKING (workspace payload):** add optional snapshot references to the
  closed assistant-message schema, with workspace revision 37 and migration
  guidance. The Hub API revision remains 14; bundled-web revision 4 refreshes
  older assets before they consume the new payload.

## Capabilities

### New Capabilities

- `chat-visuals`: safe inline assistant visuals, immutable capture, source
  access, and native session presentation guidance shared across agents.

### Modified Capabilities

None. Existing attachment, safe-Markdown, copy-action, native-history, and
reading-position requirements continue to apply without weakening them.

## Impact

The change affects chat Markdown preparation, visual state storage,
multi-agent snapshot/event enrichment, Claude normalization, native session
startup, authenticated workspace routes, timeline controls, CSS, API payload
schemas, and chat documentation. It reuses installed rendering libraries;
no new dependency, sharing tool, mandatory skill, or extraction of native
tool-result images is proposed. Repository/global instructions are unchanged.

The initial review baseline is upstream `71e4700`, integrated by merge
`331661b`. The current integration base is upstream `ab6f4c2`
(latest rebase on 2026-11-09).
At the planning-approval checkpoint, generated-input safety tests,
independent fix review, and pinned-SDK validation remained outstanding.
See [tasks.md](tasks.md) for current verification and blockers. A narrow
focused-composer touch-Latest fix was also approved on 2026-10-30 after the
image-anchor tests exposed that interaction; unrelated dependency remediation
remains outside this change.

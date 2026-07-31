# Security Policy

## Supported versions

Only the latest release receives security fixes. uatu ships as a
single-binary CLI (and a macOS desktop wrapper around it); upgrade to the
newest version before reporting an issue, since fixes are not backported.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub private vulnerability
reporting:

https://github.com/tjakobsson/uatu/security/advisories/new

Do not open a public issue for a security problem. You will receive an
acknowledgement within 7 days. Coordinated disclosure is appreciated —
give the fix a chance to ship before publishing details.

## Scope

uatu is a local-first tool: the server binds for a single local user and
the browser UI is that same user's session. That shapes what counts as a
vulnerability.

**In scope:**

- The embedded terminal's authentication (token issuance, validation, or
  any way to attach to a PTY without the token)
- The render/sanitization pipeline — markdown, AsciiDoc, and Mermaid
  handling that lets a watched document execute script or escape its
  sandbox in the preview
- File serving and path handling — reading files outside the watched
  roots via crafted paths or symlinks
- Release-artifact integrity — checksums, provenance attestations, or the
  release pipeline producing assets that don't match the source

**Out of scope:**

- Attacks that require the local user's own privileges (anyone who can
  already run commands as you doesn't need uatu to do so)
- Denial of service against your own local server
- Issues in dependencies with no demonstrated impact on uatu (report
  those upstream; we track advisories via scheduled dependency audits)

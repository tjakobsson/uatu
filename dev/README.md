# Dev hub

`bun run dev` runs [`scripts/dev-hub.ts`](../scripts/dev-hub.ts). It starts
`uatu hub` from source with [`hub.json`](./hub.json), registers
`testdata/watch-docs` if the hub doesn't have it yet, starts that session, and
opens it in your browser. The first time, the browser lands on the hub's
login page.

| | |
|---|---|
| URL | `http://127.0.0.1:4702/` |
| User | `dev` |
| Password | `dev` |
| State | `.local/dev-hub/` (git-ignored) |

The password exists only to satisfy the hub's login gate. The hub binds
loopback only, and port 4702 keeps it clear of an installed hub on the
default 4700.

```bash
bun run dev             # start the dev hub and open the session
bun run dev --no-open   # start it without opening a browser
bun run dev --github-fake  # also serve MOCKED GitHub pull request data
```

`--github-fake` sets `UATU_GITHUB_FAKE=1` for the hub, which its sessions
inherit. The Pull request pane, the PR preview and the workspace
switcher's Pull requests then work against an in-memory fake
([`src/github/fake.ts`](../src/github/fake.ts)) seeded with fictional data
(`octo-org/uatu`, PR #642, viewer `octo-reviewer`). Comments and reviews
change only that memory; nothing reaches GitHub, and every surface says the
data is mocked. uatu never merges: the pane shows merge readiness and links
to GitHub. The PR file view reads the fake's file contents (each changed
file's two sides, plus a few unchanged files per pull request: #639 has a
Markdown file with Mermaid and a relative image, and an AsciiDoc file). The
pane's "Mock scenario" control switches between
`ready`, `head-not-fetched` (every pull request but the branch's own asks
for its head to be fetched before its files show; Fetch succeeds at once),
`no-pull-request`, `no-credential`, `rate-limited` and
`unavailable`, and resets the data after asking. `UATU_GITHUB_FAKE_SCENARIO=<name>` picks
the starting scenario.

Without the flag, sessions use the real GitHub backend: the session's own
`gh` (`gh api` only), with the credential the Hub assigned to the workspace
(Settings → Credentials, a token with GitHub CLI access). The dev hub assigns
none, so a GitHub repository shows the "GitHub isn't connected" guidance and
no request leaves the machine. One setting controls the backend, inherited by
the sessions like the flag above:

| Variable | Values | Effect |
|---|---|---|
| `UATU_GITHUB` | `read` (default), `full`, `off` | `read` reads pull requests only (every write is refused and sending says why); `full` also sends comments and reviews; `off` turns pull requests off (every `/api/github/*` route answers 404). Any other value means `off`. `off` also wins over `UATU_GITHUB_FAKE`. The default is `read` until the manual acceptance against real GitHub passes. |
| `UATU_GITHUB_FAKE` | `1` | The in-memory fake instead of GitHub. It has no read-only mode, so `--github-fake` keeps its writes. |
| `UATU_GITHUB_FAKE_SCENARIO` | a scenario name | The fake's starting scenario. |

For example, `UATU_GITHUB=full bun run dev` starts a dev hub whose sessions
send comments and reviews; plain `bun run dev` reads GitHub but never posts.

Ctrl+C stops the hub, and the hub stops its session children. Add more
folders from the dashboard. To start over, stop the hub and delete
`.local/dev-hub/`.

`stateDir` is relative, so it resolves against the hub's working directory.
The script always starts the hub from the repository root. To run the same
config by hand, do it from the root too:

```bash
bun run src/cli.ts hub --config dev/hub.json
```

To change the password, hash a new one and replace `passwordHash`:

```bash
printf '%s' 'new-password' | bun run src/cli.ts hub hash-password
```

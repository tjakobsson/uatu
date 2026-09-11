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
```

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

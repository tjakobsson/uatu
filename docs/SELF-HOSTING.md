# Self-hosting the UatuCode Hub

`uatu hub` turns a machine you own — a homelab box, a spare Mac mini, a VPS —
into a session server: it serves a dashboard over one HTTPS port, supervises
one `uatu serve` child per workspace, and reverse-proxies every session under
`https://<your-host>/s/<workspace-id>/`. Any browser is a client; an iPad can
install the hub as a PWA and every session lives inside it, and UatuCode
Desktop is a native hub client — Add Hub… on its splash screen signs in and
opens the hub's dashboard. The hub is the only front door: `uatu hub` is the
way to run uatu, and every client authenticates the same way.

This document is the operator runbook: the trust model, the config
reference, certificate walkthroughs (mkcert and both tailscale shapes), and
service definitions for systemd and launchd.

## The trust model — read this first

- **Hub login answers "may this person enter", nothing more.** Every
  session's terminal is a real shell running as the OS user the hub daemon
  runs as. There is **no isolation between hub users or between sessions**:
  anyone you configure in `users` can read, modify, and execute anything
  that OS user can. Configure only people you would trust with the account
  itself.
- **Login is required on every interface, loopback included.** There is no
  trusted local mode: `127.0.0.1` is gated exactly like a remote address,
  and a hub on your own machine still takes a one-user config and a login.
- **Sign-out is server-side revocation.** Sessions are records in the hub's
  state dir, not self-contained tokens: signing out (or revoking a device
  from the dashboard's Devices pane) kills that session immediately for
  every client holding it — browser cookie and native app alike. The
  dashboard lists your active sessions per device so you can revoke a lost
  or stale one.
- **Sessions are children of the hub.** If the hub process dies, its
  children exit too (they hold a stdin pipe from the hub and exit on EOF —
  the same orphan backstop the desktop app uses). A `systemctl restart`
  therefore restarts sessions: workspaces stay registered and resume from
  the dashboard, but running shells are lost. Plan restarts like you would
  plan rebooting a machine people are working on.
- **HTTPS is functionally required for remote use**, not just prudent:
  browsers gate service workers (the PWA install) and the clipboard API
  behind secure contexts. Plain HTTP is only permitted on loopback — the
  hub refuses to bind a non-loopback address without TLS.
- **Local credential assignments are tool configuration, not isolation.**
  Every workspace runs under the Hub daemon's OS UID. Normal Git, SSH, GnuPG,
  `gh`, and `glab` use only the credentials assigned when the workspace starts,
  but another same-UID process can inspect runtime files, reach shared Hub
  agents, unset that configuration, and use a credential assigned elsewhere.
  Restart a running workspace after changing its assignments.
- **Signed-in users can browse the daemon user's filesystem.** The
  dashboard's Add Folder browser lists directories so users can pick any
  folder to serve. This adds nothing to the threat model — the embedded
  terminal already grants a full shell as the daemon user — but be aware
  that the login is the *only* boundary.

## Configuration

The hub reads one JSON file — `uatu hub --config /path/hub.json`, defaulting
to `$XDG_CONFIG_HOME/uatu/hub.json` (usually `~/.config/uatu/hub.json`):

```json
{
  "port": 4700,
  "host": "0.0.0.0",
  "tls": {
    "cert": "/etc/uatu/fullchain.pem",
    "key": "/etc/uatu/key.pem"
  },
  "users": [
    { "name": "tobias", "passwordHash": "$argon2id$…" }
  ],
  "stateDir": "~/.local/state/uatu-hub"
}
```

| Field | Default | Meaning |
|---|---|---|
| `port` | `4700` | Listen port |
| `host` | `127.0.0.1` | Bind address. Non-loopback requires `tls`. |
| `tls` | none | PEM certificate + private key paths. Omit only for loopback (dev, or behind your own HTTPS proxy). |
| `users` | — | Required, non-empty. Password hashes only — generate with `uatu hub hash-password`. |
| `stateDir` | `~/.local/state/uatu-hub` | Workspace registry, personal workspace state, and the session store (secret-bearing files are created owner-only) |

Generate a password hash (read from stdin so it never lands in shell
history):

```sh
printf '%s' 'your-password-here' | uatu hub hash-password
```

Paste the printed `$argon2id$…` string into `users[].passwordHash`.

**Workspaces are folders you add**, anywhere on the machine: the dashboard's
Add Folder pane is a directory browser (starting at the daemon user's home)
— drill to a folder and add it, and `git clone` checks out into whichever
directory you have browsed to. There is no configured workspaces root; a
`workspacesDir` key in the config is rejected at startup (it existed only in
pre-release edge builds — delete the key).

Clone credentials are selected in the dashboard's clone panel. The Hub runs
Git in a dedicated pseudo-terminal and disables ambient Git/SSH askpass
programs, credential helpers, and agent sockets for that clone. Select a
compatible Hub credential or answer Git and OpenSSH prompts in the browser.
Interactive responses go only to that clone terminal; the Hub does not store
them or echo them in its log.

State that persists across restarts includes the workspace registry, Hub
credentials and assignments, tool overrides, the session store, and
`personal-workspace-state.json`. Workspace ids are stable. Delete
`sessions.json` in the state directory to force everyone to sign in again, or
revoke individual devices from the dashboard. Personal state is isolated by
signed-in user and workspace and contains resume choices such as document,
Follow, preview/filter/compare modes, and the last-active PTY reference.
Browser layout, dock, split, and dimensions remain client-local. Forgetting a
stopped workspace removes every user's personal record and its credential
assignments as part of the same coordinated operation.

## Credential setup and migration

The Hub no longer inherits `SSH_AUTH_SOCK`, system GnuPG homes, provider CLI
sessions, or ambient Git credential helpers for clone jobs and workspaces.
This is an intentional breaking change. Existing installations must create or
import Hub credentials and assign them before unattended `fetch`, `pull`,
`push`, provider CLI, or signed-commit jobs resume. Interactive clone prompts
remain available when no stored credential is selected.

The dashboard shows this migration warning once per signed-in user and browser
profile. Dismissing it stores only a versioned, user-scoped flag in that Hub
origin's browser storage. The login page does not read or render the flag.

### Install and check tools

The service account needs `git` and OpenSSH for SSH authentication or signing.
Install GnuPG only for OpenPGP signing, `gh` only for GitHub CLI access, and
`glab` only for GitLab CLI access.

```sh
# macOS with Homebrew
brew install git openssh gnupg gh glab

# Debian or Ubuntu
sudo apt-get update
sudo apt-get install git openssh-client gnupg gh
# Install glab from GitLab's supported package repository if needed.
```

Run the Hub under the same service account it will use in production, open
**Credentials > Credential tools**, and use **Test** for each required tool.
Service managers often provide a shorter `PATH` than an interactive shell. If
discovery misses an installed executable, save its absolute path in that pane
and test again. A bad override does not replace the last usable path. Missing
GnuPG, `gh`, or `glab` disables only the capability that needs it.

### Create credentials

1. Open the authenticated dashboard's **Credentials** pane.
2. Generate a passphrase-protected SSH key, import an existing SSH private
   key, generate or import an OpenPGP signing key, or add an HTTPS/provider
   token. Select only the capabilities the credential needs.
3. For SSH and OpenPGP credentials, use **Copy public key** and register the
   public material with the provider or Git server. The Hub does not register
   keys remotely.
4. Unlock SSH and OpenPGP credentials, then run **Test**. Passphrases are used
   for that operation and discarded. SSH and OpenPGP credentials return to a
   locked state after a Hub restart; tokens remain usable until disabled or
   deleted.
5. Assign an authentication default for each required provider host and, when
   needed, one commit-signing default per workspace. Restart any running
   workspace marked **Restart required**.

For GitHub, add an SSH authentication key under **Settings > SSH and GPG
keys > New SSH key**. Add SSH signing keys as a signing key in the same area,
or add an OpenPGP public key under **New GPG key**. For GitLab, use
**Preferences > SSH Keys** or **GPG Keys**. Other providers use their own key
registration pages. Provider access controls still decide what the key or
token may do.

New credentials have no assignments. A clone can use a credential once and
optionally retain it as the new workspace's authentication assignment. With no
selection, Git prompts in the clone panel and the supplied values are not
promoted to stored credentials.

### Managed agents and the shared UID

The Hub owns a dedicated SSH agent socket under `credential-runtime/` and a
dedicated GnuPG home under `credential-gnupg/`. It never loads keys into,
locks, reconfigures, or stops the service account's system agents. On graceful
shutdown it stops clone jobs and workspaces before stopping only the agents it
can prove it owns. Runtime files are recreated on startup and are not backup
material.

Assignments configure normal Git, SSH, GnuPG, `gh`, and `glab` selection. They
are not an access-control boundary in the local backend. Every workspace and
Hub user runs as the daemon's OS UID. A same-UID process can inspect generated
runtime files, reach a shared managed agent, remove the generated settings, or
use a credential assigned to another workspace. Use a separate machine, VM,
container, or OS account when credentials must be isolated from one another.

### Back up and restore credentials

The state directory contains workspace and login state plus these credential
files:

- `credentials.json` stores public metadata and assignments.
- `credential-tools.json` stores validated executable overrides.
- `credential-secrets/` stores passphrase-encrypted SSH private keys and the
  owner-only token store.
- `credential-gnupg/` stores the Hub's private OpenPGP home.
- `credential-runtime/` is temporary and must not be backed up or restored.

Stop the Hub before taking a consistent backup. Copy the config and state
directory to encrypted storage while preserving ownership and mode bits. The
token store relies on filesystem permissions, so anyone who can read the
backup can use its tokens. Keep SSH/OpenPGP passphrases separately. On restore,
leave the Hub stopped, restore the files to the configured `stateDir`, set the
tree to the service account, and ensure private directories are mode `0700`
and private files are mode `0600`. Do not restore `credential-runtime/`.
Start the Hub, test tools and credentials, unlock keys, and restart workspaces.

### Revoke and remove access

Use **Lock** to remove an SSH or OpenPGP identity from the Hub-managed agent.
Use **Disable** or **Unassign** to prevent new Hub-selected use, and **Delete**
to remove local backing after confirming assignment removal. These actions do
not terminate an existing SSH multiplexed connection or revoke provider-side
tokens and sessions. For a lost or compromised credential, also delete the
public key or revoke the token at every provider, close persistent remote
connections, rotate the credential, update assignments, and restart affected
workspaces. Device revocation in the dashboard revokes Hub login only; it does
not revoke Git credentials.

### Roll back the migration

To return temporarily to a pre-managed-credential release, stop the Hub, back
up its state directory, install the previous binary, and start the service with
the old environment and agent sockets configured as that release expected.
Restart all workspaces so they inherit the old process environment. The old
binary ignores the new credential files; it does not convert Hub-managed keys
into system-agent identities. Do not delete the new state until the rollback
has been verified. Restoring the current binary restores managed behavior, but
SSH and OpenPGP keys must be unlocked again.

## Certificates — three worked paths

### Path A: mkcert (LAN homelab, no domain)

[mkcert](https://github.com/FiloSottile/mkcert) runs a private CA on your
machine and issues certificates your own devices trust.

```sh
# On the server
brew install mkcert   # or: apt install mkcert / the release binary
mkcert -install
mkcert -cert-file ~/.config/uatu/cert.pem -key-file ~/.config/uatu/key.pem \
  homebox.lan 192.168.1.50
```

Point the config at the two files:

```json
"host": "0.0.0.0",
"tls": { "cert": "~/.config/uatu/cert.pem", "key": "~/.config/uatu/key.pem" }
```

**Trust the CA on your iPad/iPhone** (once): run `mkcert -CAROOT` to find
`rootCA.pem`, get it onto the device (AirDrop works), then Settings →
General → VPN & Device Management → install the profile, and Settings →
General → About → Certificate Trust Settings → enable full trust for it.
Safari will then treat `https://homebox.lan:4700` as secure, which is what
makes the PWA install and clipboard work.

**Trust the CA on other Macs (UatuCode Desktop)**: the desktop app connects
to hubs with system trust only — there is no certificate-exception dialog.
On any Mac that isn't the mkcert machine, import `rootCA.pem` into the
System keychain and mark it trusted:

```sh
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain rootCA.pem
```

Certificates from a public CA (Path B/C, Let's Encrypt via tailscale) need
none of this — they are trusted everywhere already.

Finish with the [systemd unit](#systemd) or [launchd plist](#launchd) below.

### Path B: tailscale, native TLS (`tailscale cert`)

Tailscale can mint a real Let's Encrypt certificate for your machine's
tailnet name — no CA installs on any device.

1. In the [tailscale admin console](https://login.tailscale.com/admin/dns),
   enable **MagicDNS** and **HTTPS certificates**.
2. On the server:

```sh
tailscale cert homebox.tail1234.ts.net
# → homebox.tail1234.ts.net.crt / homebox.tail1234.ts.net.key in $PWD
mkdir -p ~/.config/uatu
mv homebox.tail1234.ts.net.crt ~/.config/uatu/cert.pem
mv homebox.tail1234.ts.net.key ~/.config/uatu/key.pem
```

3. Config:

```json
"host": "0.0.0.0",
"tls": { "cert": "~/.config/uatu/cert.pem", "key": "~/.config/uatu/key.pem" }
```

The hub is now `https://homebox.tail1234.ts.net:4700` from every device on
your tailnet.

**Renewal is on you** — these certificates expire after ~90 days. A systemd
timer re-running `tailscale cert` monthly keeps them fresh:

```ini
# /etc/systemd/system/uatu-hub-cert.service
[Unit]
Description=Renew tailscale certificate for uatu hub

[Service]
Type=oneshot
User=uatu
ExecStart=/bin/sh -c 'cd /home/uatu/.config/uatu && tailscale cert \
  --cert-file cert.pem --key-file key.pem homebox.tail1234.ts.net'
ExecStartPost=/usr/bin/systemctl restart uatu-hub.service
```

```ini
# /etc/systemd/system/uatu-hub-cert.timer
[Unit]
Description=Monthly uatu hub certificate renewal

[Timer]
OnCalendar=monthly
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
sudo systemctl enable --now uatu-hub-cert.timer
```

(Note the restart in `ExecStartPost` — the hub reads the PEM files at
startup, and remember that a restart restarts sessions.)

Finish with the [systemd unit](#systemd) below.

### Path C: tailscale, fronted (`tailscale serve`)

Zero certificate management: the hub listens plain-HTTP on loopback and
`tailscale serve` terminates HTTPS in front of it, minting and renewing
certificates itself.

Config — note loopback host and **no `tls` block**:

```json
"port": 4700,
"host": "127.0.0.1"
```

Then:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4700
tailscale serve status   # verify
```

The hub is now `https://homebox.tail1234.ts.net/` on your tailnet. The
`--bg` configuration persists across reboots on its own; you only need the
hub service below.

Finish with the [systemd unit](#systemd) or [launchd plist](#launchd) below.

### Path C variant: your own reverse proxy (Caddy, nginx)

The same loopback shape works with any HTTPS-terminating proxy — with one
requirement: **the proxy must pass the browser's `Host` through unchanged**,
because the hub validates the browser's `Origin` against the `Host` it
receives (login, state-changing APIs, and session WebSockets all 403 on a
mismatch). It should also forward the scheme and client address so cookies
gain `Secure` and login rate limiting keys per client.

Caddy does all of this by default — `reverse_proxy 127.0.0.1:4700` is a
complete config. nginx does **not**: a default `proxy_pass` rewrites `Host`
to the upstream address. A working block:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}

server {
    listen 443 ssl;
    server_name hub.example.com;
    # ssl_certificate / ssl_certificate_key as usual

    location / {
        proxy_pass http://127.0.0.1:4700;
        proxy_http_version 1.1;
        # REQUIRED: the hub's origin gate compares Origin against this.
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # WebSockets (the terminal) and SSE (live reload).
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 1d;
    }
}
```

## Running as a service

### systemd (Linux) {#systemd}

```ini
# /etc/systemd/system/uatu-hub.service
[Unit]
Description=UatuCode Hub
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=uatu
ExecStart=/usr/local/bin/uatu hub --config /home/uatu/.config/uatu/hub.json
Restart=on-failure
# The hub prints its URL on stdout and operational notes on stderr.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now uatu-hub.service
journalctl -u uatu-hub -f     # watch it come up
```

Remember: `systemctl restart uatu-hub` terminates running sessions'
shells. Workspaces resume from the dashboard.

### launchd (macOS) {#launchd}

```xml
<!-- ~/Library/LaunchAgents/se.coll8.uatu-hub.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>se.coll8.uatu-hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/uatu</string>
    <string>hub</string>
    <string>--config</string>
    <string>/Users/you/.config/uatu/hub.json</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/tmp/uatu-hub.log</string>
  <key>StandardErrorPath</key><string>/tmp/uatu-hub.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/se.coll8.uatu-hub.plist
launchctl kickstart -k gui/$(id -u)/se.coll8.uatu-hub
tail -f /tmp/uatu-hub.log
```

## Day-2 notes

- **Dashboard**: running sessions show live shell detail (count,
  attached/detached, foreground process) — an agent chewing away in a
  session is visible at a glance. Jump-in URLs and bookmarks are stable per
  workspace.
- **Losing connectivity is fine**: closing the iPad's lid, a train tunnel, a
  hub-reachability blip — terminal sessions detach and reattach with their
  scrollback and active TUI state; the shell keeps running as long as the
  *child* stays up. A different client sees the PTY in the session picker and
  must explicitly attach or take it over; saved last-active state never causes
  an automatic cross-client attachment.
- **Stopping a session** from the dashboard terminates its shells — the
  dashboard asks for confirmation naming the workspace.
- **Login lockout**: five failed attempts per minute per address; wait a
  minute. Revoke a single device from the dashboard's Devices pane; rotate
  everyone's sessions by deleting `sessions.json` in the state dir.
- **Sizing**: each running session is one Bun process (plus a watchdog and
  your shells). A handful of sessions is well within a small homelab box.

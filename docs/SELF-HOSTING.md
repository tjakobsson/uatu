# Self-hosting the UatuCode Hub

`uatu hub` turns a machine you own — a homelab box, a spare Mac mini, a VPS —
into a session server: it serves a dashboard over one HTTPS port, supervises
one `uatu serve` child per workspace, and reverse-proxies every session under
`https://<your-host>/s/<workspace-id>/`. Any browser is a client; an iPad can
install the hub as a PWA and every session lives inside it, and UatuCode
Desktop can connect natively — Add Hub… on its splash screen signs in and
lists the hub's workspaces alongside local ones.

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
- **`git clone` runs with the daemon user's ambient credentials** (its
  `~/.gitconfig`, ssh agent, credential helpers). The hub stores no
  credentials of its own.
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
| `stateDir` | `~/.local/state/uatu-hub` | Workspace registry + cookie-signing key (created `0600`) |

**Workspaces are folders you add**, anywhere on the machine: the dashboard's
Add Folder pane is a directory browser (starting at the daemon user's home)
— drill to a folder and add it, and `git clone` checks out into whichever
directory you have browsed to. There is no configured workspaces root; a
`workspacesDir` key in the config is rejected at startup (it existed only in
pre-release edge builds — delete the key).

Generate a password hash (read from stdin so it never lands in shell
history):

```sh
printf '%s' 'your-password-here' | uatu hub hash-password
```

Paste the printed `$argon2id$…` string into `users[].passwordHash`.

State that persists across restarts: the workspace registry (ids are stable —
`/s/uatu/` today is `/s/uatu/` after any number of restarts) and the
cookie-signing key (logins survive restarts; delete
`~/.local/state/uatu-hub/hub.key` to force everyone to sign in again).

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
  scrollback; the shell keeps running as long as the *child* stays up.
- **Stopping a session** from the dashboard terminates its shells — the
  dashboard asks for confirmation naming the workspace.
- **Login lockout**: five failed attempts per minute per address; wait a
  minute. Rotate everyone's sessions by deleting `hub.key` in the state dir.
- **Sizing**: each running session is one Bun process (plus a watchdog and
  your shells). A handful of sessions is well within a small homelab box.

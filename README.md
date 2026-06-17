<div align="center">

# ∇ MCNU Status

**Follow the gradient — even when it points down.**

A self-hosted status & monitoring suite for the MCNU Labs infrastructure.
One service, two faces: a **public status page** the world can trust, and a
**private operator dashboard** that never leaks a thing.

`AI · ML · Quantum` — and the machines that keep them running.

</div>

---

## The 3 things that matter

1. **Two faces, one truth.** `/` is public (components, uptime, incidents — abstract
   names only). `/admin` is private (raw services, disk, certs, incident authoring).
   The public page **never** reveals an internal URL, service name, or host detail.
2. **Read-only by design.** The dashboard runs fixed, argument-array commands via
   `execFile` (no shell, no user input interpolated) as an unprivileged `status`
   user with no `sudo`. It observes; it never mutates the box.
3. **It tells you before you find out.** A prober watches every component on a
   60-second beat, opens/closes incidents automatically, and alerts you over
   **email, SMS, and Web Push** the moment something breaks — and again when it heals.

> Palette: cyan `#22D3EE` · violet `#A78BFA` · ink `#0A0E1A`.
> Type: **Press Start 2P** (labels) · **Inter** (everything readable). Dark-first, always.

---

## What's where, and what it does

### 🜂 Public status page — `status.mcnu.ro/`
The face the world sees. No login. Shows:
- **Overall banner** — a pulsing status ring: *All Systems Operational* / *Degraded* / *Major Outage*.
- **Summary stats** — components operational, aggregate 90-day uptime, active incidents.
- **Grouped components** — collapsible groups (e.g. *Mail*, *Web*) with an aggregate
  status pill + uptime bar; expand to see each member's 90-day color history.
- **Live Metrics** — latency sparklines, but only for components flagged *important*.
- **Incident history** — a timeline with status badges (investigating → monitoring → resolved).

It exposes **only** abstract labels + up/down + uptime + incidents. The probe target
(`https://…/api/health`, `smtp.purelymail.com:465`, …) never leaves the server.

### ⚙ Operator dashboard — `status.mcnu.ro/admin`
Behind a password. The raw truth of the box:
- **System** — hostname, uptime, load average, memory.
- **Disk** — usage % for a configured mount (default `/`).
- **Services** — up/down + uptime for configured `systemd` units.
- **TLS certificates** — days left until expiry (catches a dead renewal timer).
- **Health probes** — live hit of configured HTTP(s) endpoints.
- **🔔 ALERTS** — subscribe this device to Web Push.
- **INCIDENTS** — author maintenance windows & notes, post updates, resolve, delete.

Auto-refreshes every 5s; pauses when the tab is hidden.

---

## How the gradient is measured — probe types

Each component declares a `type` in `STATUS_COMPONENTS`:

| type      | checks                          | "up" when                                              |
|-----------|---------------------------------|--------------------------------------------------------|
| `http`    | HTTP(S) reachable               | response `< 500` (a `4xx` is the app talking — still up) |
| `keyword` | HTTP body contains text         | `< 500` **and** body includes the expected string (case-insensitive) |
| `tls`     | certificate expiry              | cert still valid; detail warns when `< warnDays`       |
| `tcp`     | port reachable (SMTP/IMAP/SSH…) | TCP connect succeeds                                   |
| `dns`     | domain resolves                 | resolves (optionally to an expected IP)                |

A prober hits each component every `STATUS_PROBE_INTERVAL_MS` (default 60s) and stores
results in `.data/status.db` (SQLite, WAL mode). Checks auto-prune after 120 days.

---

## Components — the config grammar

`STATUS_COMPONENTS` is a comma-separated list. Each entry's fields are `|`-separated:

```
key|Label|https://url                          # http (legacy shorthand)
key|Label|http|https://url
key|Label|keyword|https://url|ExpectedText
key|Label|tls|host[:port][|warnDays]
key|Label|tcp|host:port
key|Label|dns|host[|expectedIP]
```

Two modifiers on the **key**:
- **Group** — prefix with `group/`: `mail/webmail` → group *mail*, key *webmail*.
- **Important** — suffix with `!`: `mail/webmail!` → also shown in **Live Metrics**.

Real example (the live MCNU config):
```
STATUS_COMPONENTS=mail/webmail!|Webmail|https://mail.mcnu.ro/api/health,mail/cert|Certificate|tls|mail.mcnu.ro,mail/smtp|Outgoing (SMTP)|tcp|smtp.purelymail.com:465,mail/imap|Incoming (IMAP)|tcp|imap.purelymail.com:993,web/site!|Website|keyword|https://mcnu.ro|MCNU,web/dns|DNS|dns|mcnu.ro
```

---

## Incidents

- **Automatic** — after `STATUS_FAILS_TO_INCIDENT` consecutive failures (default 2) an
  incident opens; it auto-resolves when the component recovers. Both transitions alert.
- **Manual** — from `/admin → INCIDENTS`: post maintenance windows, add timeline
  updates, resolve, or delete. Useful for "scheduled DB upgrade tonight 22:00".

Resolved incidents stay in the public history (that's the point of a status page);
delete a false positive manually if you want it gone.

---

## Alerting

On an incident **open** or **resolve** the configured channels fire — each independent,
each activating only when fully configured. Alerts fire on the *transition* only, never
on every probe.

| channel       | enable with                                              |
|---------------|----------------------------------------------------------|
| **Email**     | `ALERT_SMTP_HOST/PORT/USER/PASS` + `ALERT_EMAIL_FROM/TO` |
| **SMS** (SMSO)| `SMSO_API_KEY` + `SMSO_TO` (sender auto-discovered)      |
| **Web Push**  | `VAPID_PUBLIC/PRIVATE`, then click **🔔 ALERTS** on `/admin` |

Generate VAPID keys:
```bash
node -e "const wp=require('web-push');const k=wp.generateVAPIDKeys();console.log('VAPID_PUBLIC='+k.publicKey+'\nVAPID_PRIVATE='+k.privateKey)"
```

---

## Security model

- **Auth** — single password (`STATUS_PASS`), timing-safe compare, per-IP lockout
  (8 fails → 15-min cooldown). Sessions are signed (`SESSION_SECRET`), `HttpOnly`,
  `SameSite=Lax`, `Secure` in production.
- **No injection surface** — every system probe is a fixed `execFile` call with an
  argument array (`systemctl is-active/show`, `df`); memory/load and cert parsing are
  pure Node. No shell, no interpolated input.
- **Least privilege** — runs as the unprivileged `status` user, no `sudo`. The systemd
  unit is hardened (`ProtectSystem=strict`, `NoNewPrivileges`, capability set emptied;
  `ReadWritePaths` limited to `.data/`).
- **No public leakage** — the `/api/public/*` surface returns only labels, states,
  uptime, and incidents. Internal targets stay server-side.

---

## Install (VPS)

```bash
# 1. Unprivileged user + dir
sudo useradd --system --create-home --home-dir /opt/status-dashboard status

# 2. Copy the code (from your machine):
#    scp -r server public package.json package-lock.json deploy status@HOST:/opt/status-dashboard/
sudo chown -R status:status /opt/status-dashboard

# 3. Install deps (better-sqlite3 compiles natively — needs build tools)
sudo apt install -y python3 make g++          # if npm ci complains about gyp
sudo -u status npm ci --omit=dev --prefix /opt/status-dashboard

# 4. Configure
sudo -u status cp /opt/status-dashboard/.env.example /opt/status-dashboard/.env
sudo -u status nano /opt/status-dashboard/.env
#    SESSION_SECRET: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
sudo -u status chmod 600 /opt/status-dashboard/.env

# 5. SQLite dir must exist before the hardened unit starts
sudo -u status mkdir -p /opt/status-dashboard/.data

# 6. Cert read access — the 'status' user must READ the certs in STATUS_CERTS
sudo apt install -y acl
sudo setfacl -R -m u:status:rX /etc/letsencrypt/live /etc/letsencrypt/archive

# 7. systemd
sudo cp /opt/status-dashboard/deploy/status.service /etc/systemd/system/status-dashboard.service
sudo systemctl daemon-reload && sudo systemctl enable --now status-dashboard
sudo systemctl status status-dashboard --no-pager

# 8. nginx + TLS
sudo cp /opt/status-dashboard/deploy/nginx.conf /etc/nginx/sites-available/status
sudo ln -sf /etc/nginx/sites-available/status /etc/nginx/sites-enabled/status
sudo certbot --nginx -d status.mcnu.ro
sudo nginx -t && sudo systemctl reload nginx
```

### Keep cert read-access after renewals
certbot resets permissions on renewal; re-apply the ACL automatically:
```bash
echo 'setfacl -R -m u:status:rX /etc/letsencrypt/live /etc/letsencrypt/archive' \
  | sudo tee /etc/letsencrypt/renewal-hooks/deploy/status-acl.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/status-acl.sh
```

---

## Local dev

```bash
npm install
cp .env.example .env        # set STATUS_PASS at least
npm run dev                 # http://127.0.0.1:3001
```
On non-Linux, the system collectors (`systemctl`, `df`) degrade gracefully to
`{error}` instead of crashing — the page still renders.

---

## Operating notes

- **New install looks empty — that's correct.** Uptime bars show 90 days; until the
  prober has run that long, past days are honestly grey ("no data"). Today fills in
  first; the bars grow a slot per day.
- **Test alerts without a real outage** — add a component that always fails, e.g.
  `test|Test|tcp|127.0.0.1:1`. After 2 probes an incident opens and every channel
  fires. Remove it after.
- **Health endpoint** — pair this with each watched service exposing `/api/health`
  that returns `503` when degraded (not just process-up), so the probe catches a live
  process with dead internals.

---

<div align="center">

**∇ FOLLOW THE GRADIENT**

© 2026 MCNU Labs · AI · ML · Quantum

</div>

# Server status dashboard

A small, private dashboard showing systemd services, disk, memory/load, TLS cert
expiry, and HTTP health probes. Read-only — it never changes anything on the box.

## What it shows
- **System**: hostname, uptime, load average, memory usage
- **Disk**: usage % for a configured mount (default `/`)
- **Services**: up/down + uptime for configured systemd units
- **TLS certificates**: days left until expiry (catches renewal failures)
- **Health probes**: hits configured HTTP(s) URLs (e.g. your webmail `/api/health`)

Auto-refreshes every 5s; everything is behind a password login.

## Security model
- Single password login (`STATUS_PASS`), timing-safe compare, per-IP lockout.
- The backend runs **only fixed, read-only commands** via `execFile` (no shell,
  no user input interpolated): `systemctl is-active/show`, `df`, plus pure Node
  for memory/load and cert parsing. There is no command-injection surface.
- Runs as an unprivileged `status` user. No `sudo`.

## Install (VPS)

```bash
# 1. Create an unprivileged user + dir
sudo useradd --system --create-home --home-dir /opt/status-dashboard status
sudo chown -R status:status /opt/status-dashboard

# 2. Copy the code (from your machine):
#    scp -r server public package.json package-lock.json status@HOST:/opt/status-dashboard/

# 3. Install deps
cd /opt/status-dashboard && sudo -u status npm ci --omit=dev

# 4. Configure
sudo -u status cp .env.example .env
sudo -u status nano .env     # set STATUS_PASS, SESSION_SECRET, services, certs, health URLs
#   Generate SESSION_SECRET: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 5. Cert read access — the 'status' user must be able to READ the letsencrypt
#    fullchain.pem files you list in STATUS_CERTS. Simplest safe approach:
sudo setfacl -R -m u:status:rX /etc/letsencrypt/live /etc/letsencrypt/archive
#    (re-apply after renewals, or add a renew --deploy-hook; see below)

# 6. systemd
sudo cp deploy/status.service /etc/systemd/system/status-dashboard.service
sudo systemctl daemon-reload && sudo systemctl enable --now status-dashboard
sudo systemctl status status-dashboard --no-pager

# 7. nginx + TLS for status.mcnu.ro
sudo cp deploy/nginx.conf /etc/nginx/sites-available/status
sudo ln -s /etc/nginx/sites-available/status /etc/nginx/sites-enabled/status
sudo certbot --nginx -d status.mcnu.ro
sudo nginx -t && sudo systemctl reload nginx
```

### Keeping cert read-access after renewals
certbot resets permissions on renewal. Re-apply the ACL automatically with a deploy hook:
```bash
echo 'setfacl -R -m u:status:rX /etc/letsencrypt/live /etc/letsencrypt/archive' \
  | sudo tee /etc/letsencrypt/renewal-hooks/deploy/status-acl.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/status-acl.sh
```

## URL layout

- `https://status.mcnu.ro/` — **public** status page (no login).
- `https://status.mcnu.ro/admin` — **private** dashboard (login required).
- `https://status.mcnu.ro/login.html` — sign in (redirects to `/admin`).

## Public status page

`https://status.mcnu.ro/` is **public** (no login). It shows only abstract
component names, up/down, 90-day uptime bars, and incidents — never internal URLs,
service names, or host details.

- Configure components in `.env` via `STATUS_COMPONENTS` (`key|Label|probe-url`, comma-separated).
- A prober hits each component every `STATUS_PROBE_INTERVAL_MS` (default 60s) and stores
  results in `.data/status.db` (SQLite). Old checks auto-prune after 120 days.
- **Auto-incidents**: after `STATUS_FAILS_TO_INCIDENT` consecutive failures (default 2),
  an incident opens; it auto-resolves when the component recovers.
- **Manual incidents**: from the private dashboard, click **INCIDENTS** to post
  maintenance windows / notes, add updates, resolve, or delete.
- Turn the public page off entirely with `STATUS_PUBLIC=false`.

The SQLite DB lives in `.data/` (under `WorkingDirectory`). The systemd unit's
`ProtectSystem=strict` already allows writes there via `ReadWritePaths` — confirm
`/opt/status-dashboard/.data` is listed if you tighten the unit.

## Probe types

Each component declares a `type` in `STATUS_COMPONENTS` (see `.env.example`):

| type | checks | "up" when |
|------|--------|-----------|
| `http` | HTTP(S) reachable | response < 500 (4xx = app responding, still up) |
| `keyword` | HTTP body contains text | <500 **and** body includes the expected string |
| `tls` | certificate expiry | cert still valid; detail warns when < `warnDays` |
| `tcp` | port reachable (SMTP/IMAP/SSH…) | TCP connect succeeds |
| `dns` | domain resolves | resolves (optionally to an expected IP) |

## Alerting

On an auto-incident **open** or **resolve**, the configured channels fire (each
independent; a channel activates only when fully configured in `.env`):

- **Email** — SMTP (e.g. Purelymail): set `ALERT_SMTP_*` + `ALERT_EMAIL_FROM/TO`.
- **SMS** — SMSO (smso.ro): set `SMSO_API_KEY`, `SMSO_SENDER`, `SMSO_TO`.
- **Web Push** — own VAPID: set `VAPID_PUBLIC/PRIVATE`, then on `/admin` click
  **🔔 ALERTS** to subscribe the device. Generate keys with:
  `node -e "const wp=require('web-push');const k=wp.generateVAPIDKeys();console.log(k.publicKey,k.privateKey)"`

Notifications fire only on the open/resolve **transition**, not every probe.

## Local dev
```bash
npm install
cp .env.example .env   # set STATUS_PASS at least
npm run dev
# http://127.0.0.1:3001  (services/disk reflect YOUR machine; on Windows some collectors no-op)
```

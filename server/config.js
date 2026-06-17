import 'dotenv/config';
import crypto from 'node:crypto';

const isProd = process.env.NODE_ENV === 'production';

function required(name, fallbackDev) {
    const v = process.env[name];
    if (v) return v;
    if (isProd) {
        console.error(`FATAL: ${name} must be set in production`);
        process.exit(1);
    }
    return fallbackDev;
}

const KNOWN_TYPES = new Set(['http', 'keyword', 'tls', 'tcp', 'dns']);

// Parse the STATUS_COMPONENTS spec into typed component objects.
function parseComponents(raw) {
    return raw.split(',').map(s => s.trim()).filter(Boolean).map(spec => {
        const parts = spec.split('|').map(x => (x || '').trim());
        let [key, label] = parts;
        if (!key) return null;
        // Optional group prefix: "mail/webmail" → group "mail", key "webmail".
        let group = null;
        if (key.includes('/')) {
            const slash = key.indexOf('/');
            group = key.slice(0, slash);
            key = key.slice(slash + 1);
        }
        // Trailing "!" marks a component as important → shown in the Live Metrics
        // section with a latency sparkline. e.g. "mail/webmail!".
        let important = false;
        if (key.endsWith('!')) { important = true; key = key.slice(0, -1); }
        const base = { key, label: label || key, group, important };

        // Legacy form: key|Label|https://...  → http
        const third = parts[2] || '';
        if (!KNOWN_TYPES.has(third)) {
            return third ? { ...base, type: 'http', url: third } : null;
        }

        const type = third;
        const a = parts[3] || '';   // primary target
        const b = parts[4] || '';   // extra param
        switch (type) {
            case 'http':    return a ? { ...base, type, url: a } : null;
            case 'keyword': return (a && b) ? { ...base, type, url: a, keyword: b } : null;
            case 'tls': {
                const [host, port] = a.split(':');
                return host ? { ...base, type, host, port: port ? +port : 443, warnDays: b ? +b : 14 } : null;
            }
            case 'tcp': {
                const [host, port] = a.split(':');
                return (host && port) ? { ...base, type, host, port: +port } : null;
            }
            case 'dns':     return a ? { ...base, type, host: a, expect: b || null } : null;
            default:        return null;
        }
    }).filter(Boolean);
}

export const config = {
    isProd,
    port: parseInt(process.env.PORT || '3001', 10),
    host: process.env.HOST || '127.0.0.1',

    // Login: single password. Username is fixed ("admin") — this is a personal tool.
    login: {
        user: process.env.STATUS_USER || 'admin',
        pass: required('STATUS_PASS', 'changeme'),
    },

    // Session signing secret.
    sessionSecret: required('SESSION_SECRET', crypto.randomBytes(32).toString('hex')),

    // What to watch.
    // Comma-separated systemd unit names to report on.
    services: (process.env.STATUS_SERVICES || 'webmail,nginx,ssh')
        .split(',').map(s => s.trim()).filter(Boolean),

    // Comma-separated TLS cert paths (fullchain.pem) to check expiry on.
    // e.g. /etc/letsencrypt/live/mail.mcnu.ro/fullchain.pem
    certPaths: (process.env.STATUS_CERTS || '')
        .split(',').map(s => s.trim()).filter(Boolean),

    // Comma-separated HTTP(s) health URLs to probe (e.g. https://mail.mcnu.ro/api/health).
    healthUrls: (process.env.STATUS_HEALTH_URLS || '')
        .split(',').map(s => s.trim()).filter(Boolean),

    // Filesystem mount to report disk usage for.
    diskPath: process.env.STATUS_DISK_PATH || '/',

    // Public status page on/off + branding.
    publicEnabled: process.env.STATUS_PUBLIC !== 'false',
    publicTitle: process.env.STATUS_PUBLIC_TITLE || 'MCNU Labs',

    // PUBLIC components: abstract names users recognize, each backed by a probe.
    // The public page NEVER reveals the internal target — only the label + up/down.
    //
    // Formats (comma-separated; fields are |-separated):
    //   key|Label|https://url                         → http (legacy form)
    //   key|Label|http|https://url
    //   key|Label|keyword|https://url|ExpectedText
    //   key|Label|tls|host[:port][|warnDays]
    //   key|Label|tcp|host:port
    //   key|Label|dns|host[|expectedIP]
    // Example:
    //   STATUS_COMPONENTS="site|Website|https://mcnu.ro,mail-tls|Mail TLS|tls|mail.mcnu.ro,smtp|SMTP|tcp|smtp.purelymail.com:465"
    components: parseComponents(process.env.STATUS_COMPONENTS || ''),

    // How many consecutive failed probes before opening an auto-incident.
    failsToIncident: parseInt(process.env.STATUS_FAILS_TO_INCIDENT || '2', 10),
    // Probe interval (ms).
    probeIntervalMs: parseInt(process.env.STATUS_PROBE_INTERVAL_MS || '60000', 10),

    // --- Alerting channels (all optional; enabled only if configured) ---
    alerts: {
        // Email via SMTP. Set host/port/user/pass/from/to to enable.
        email: {
            host: process.env.ALERT_SMTP_HOST || '',
            port: parseInt(process.env.ALERT_SMTP_PORT || '465', 10),
            secure: process.env.ALERT_SMTP_SECURE !== 'false',
            user: process.env.ALERT_SMTP_USER || '',
            pass: process.env.ALERT_SMTP_PASS || '',
            from: process.env.ALERT_EMAIL_FROM || '',
            to: process.env.ALERT_EMAIL_TO || '',
        },
        // SMS via SMSO (smso.ro). Set apiKey + sender + to to enable.
        sms: {
            apiKey: process.env.SMSO_API_KEY || '',
            sender: process.env.SMSO_SENDER || '',
            to: process.env.SMSO_TO || '',
        },
        // Web Push (own VAPID). Set both keys to enable; subject = mailto: contact.
        push: {
            publicKey: process.env.VAPID_PUBLIC || '',
            privateKey: process.env.VAPID_PRIVATE || '',
            subject: process.env.VAPID_SUBJECT || 'mailto:admin@mcnu.ro',
        },
    },
};

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyFormbody from '@fastify/formbody';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { collectAll } from './collectors.js';
import { startProber, stopProber } from './prober.js';
import { initPush, isPushEnabled, publicKey, addSubscription, removeSubscription } from './push.js';
import {
    dailyUptime, uptimePct, latestCheck, recentLatency, listIncidents, ongoingIncidents,
    createManualIncident, addIncidentUpdate, deleteIncident,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = Fastify({ logger: { level: 'info' }, trustProxy: config.isProd });

await app.register(fastifyCookie);
await app.register(fastifySession, {
    secret: config.sessionSecret,
    cookie: {
        secure: config.isProd,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 * 7,
    },
    saveUninitialized: false,
});
await app.register(fastifyFormbody);
await app.register(fastifyStatic, { root: publicDir, prefix: '/' });

// --- tiny login rate-limit (per-IP) ---
const attempts = new Map();   // ip -> { count, until }
function lockoutStatus(ip) {
    const a = attempts.get(ip);
    if (a && a.until && Date.now() < a.until) {
        return { locked: true, retryAfterSec: Math.ceil((a.until - Date.now()) / 1000) };
    }
    return { locked: false };
}
function recordFail(ip) {
    const a = attempts.get(ip) || { count: 0, until: 0 };
    a.count += 1;
    if (a.count >= 8) { a.until = Date.now() + 15 * 60 * 1000; a.count = 0; }
    attempts.set(ip, a);
}
function recordOk(ip) { attempts.delete(ip); }
setInterval(() => {
    const now = Date.now();
    for (const [ip, a] of attempts) if (a.until && a.until < now) attempts.delete(ip);
}, 5 * 60 * 1000).unref();

function timingSafeEqual(a, b) {
    const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) {
        // Compare against itself to keep timing roughly constant, then fail.
        crypto.timingSafeEqual(ba, ba);
        return false;
    }
    return crypto.timingSafeEqual(ba, bb);
}

function isAuthed(req) { return req.session && req.session.user === config.login.user; }

app.decorate('requireAuth', async (req, reply) => {
    if (!isAuthed(req)) reply.code(401).send({ error: 'unauthorized' });
});

// --- auth routes ---
app.post('/api/login', async (req, reply) => {
    const ip = req.ip || 'unknown';
    const status = lockoutStatus(ip);
    if (status.locked) {
        reply.header('Retry-After', String(status.retryAfterSec));
        return reply.code(429).send({ error: `too many attempts, retry in ${status.retryAfterSec}s` });
    }
    const { user, pass } = req.body || {};
    const okUser = timingSafeEqual(user || '', config.login.user);
    const okPass = timingSafeEqual(pass || '', config.login.pass);
    if (!okUser || !okPass) {
        recordFail(ip);
        await new Promise(r => setTimeout(r, 400));
        return reply.code(401).send({ error: 'invalid credentials' });
    }
    recordOk(ip);
    req.session.user = config.login.user;
    return { ok: true };
});

app.post('/api/logout', async (req) => { await req.session.destroy(); return { ok: true }; });
app.get('/api/me', async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: 'unauthorized' });
    return { user: req.session.user };
});

// --- status (auth-gated) ---
app.get('/api/status', { preHandler: app.requireAuth }, async () => {
    return collectAll();
});

// ====================== PUBLIC STATUS PAGE ======================
// No auth. Exposes ONLY abstract component names + up/down + uptime + incidents.
// Never leaks internal probe URLs, service names, disk, or any host detail.

// Aggregate a set of component states into one group/overall verdict.
function aggregate(states) {
    if (states.some(s => s === 'down')) return 'major_outage';
    if (states.some(s => s === 'degraded')) return 'degraded';
    if (states.length && states.every(s => s === 'unknown')) return 'unknown';
    return 'operational';
}

app.get('/api/public/status', async (req, reply) => {
    if (!config.publicEnabled) return reply.code(404).send({ error: 'not found' });
    const components = config.components.map(c => {
        const last = latestCheck(c.key);
        const current = !last ? 'unknown' : (last.up ? 'operational' : 'down');
        return {
            key: c.key,
            label: c.label,
            group: c.group || null,
            current,
            uptime90: uptimePct(c.key, 90),
            latency: recentLatency(c.key, 48),
            history: dailyUptime(c.key, 90).map(d => ({ day: d.day, pct: d.pct })),
        };
    });

    // Group components in declared order; ungrouped ones go in a final null group.
    const groupOrder = [];
    const byGroup = new Map();
    for (const c of components) {
        const g = c.group;
        if (!byGroup.has(g)) { byGroup.set(g, []); groupOrder.push(g); }
        byGroup.get(g).push(c);
    }
    const groups = groupOrder.map(g => ({
        name: g,                                  // null = ungrouped
        status: aggregate(byGroup.get(g).map(c => c.current)),
        components: byGroup.get(g),
    }));

    const incidents = listIncidents(20).map(i => ({
        id: i.id,
        component: i.component,
        componentLabel: config.components.find(c => c.key === i.component)?.label || null,
        title: i.title,
        status: i.status,
        impact: i.impact,
        startedAt: i.started_at,
        resolvedAt: i.resolved_at,
        resolved: i.resolved,
        updates: i.updates,
    }));

    return {
        title: config.publicTitle,
        ts: Date.now(),
        overall: aggregate(components.map(c => c.current)),
        groups,
        components,   // kept flat too, for any simple consumer
        incidents,
    };
});

// ====================== ADMIN INCIDENT API (auth) ======================
app.get('/api/incidents', { preHandler: app.requireAuth }, async () => {
    return { incidents: listIncidents(50), ongoing: ongoingIncidents() };
});
app.post('/api/incidents', { preHandler: app.requireAuth }, async (req, reply) => {
    const { component, title, status, impact, body } = req.body || {};
    if (!title) return reply.code(400).send({ error: 'title required' });
    return { ok: true, incident: createManualIncident({ component, title, status, impact, body }) };
});
app.post('/api/incidents/:id/update', { preHandler: app.requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    const { status, body } = req.body || {};
    try { return { ok: true, incident: addIncidentUpdate(id, { status, body }) }; }
    catch (e) { return reply.code(400).send({ error: e.message }); }
});
app.delete('/api/incidents/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' });
    return { ok: deleteIncident(id) };
});
// Expose component list to the admin UI (so manual incidents can target one).
app.get('/api/components', { preHandler: app.requireAuth }, async () => {
    return { components: config.components.map(c => ({ key: c.key, label: c.label })) };
});

// --- Web Push subscription (admin only — alerts go to the operator) ---
app.get('/api/push/key', { preHandler: app.requireAuth }, async () => {
    return { enabled: isPushEnabled(), publicKey: publicKey() };
});
app.post('/api/push/subscribe', { preHandler: app.requireAuth }, async (req) => {
    addSubscription(req.body);
    return { ok: true };
});
app.post('/api/push/unsubscribe', { preHandler: app.requireAuth }, async (req) => {
    const { endpoint } = req.body || {};
    if (endpoint) removeSubscription(endpoint);
    return { ok: true };
});

// Public status page is the site root (served as index.html by @fastify/static).
// The private admin dashboard lives at /admin.
app.get('/admin', (req, reply) => reply.sendFile('admin.html'));

// --- 404 → serve the app shell for navigations ---
app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.code(404).type('text/html').send('<h1>404</h1>');
});

process.on('SIGINT', () => { stopProber(); process.exit(0); });
process.on('SIGTERM', () => { stopProber(); process.exit(0); });

try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`\n  Status dashboard on http://${config.host}:${config.port}`);
    console.log(`  watching services: ${config.services.join(', ') || '(none)'}`);
    console.log(`  certs: ${config.certPaths.length}, health probes: ${config.healthUrls.length}`);
    console.log(`  public page: ${config.publicEnabled ? 'on' : 'off'}, components: ${config.components.length}\n`);
    initPush();
    startProber();
} catch (err) {
    app.log.error(err);
    process.exit(1);
}

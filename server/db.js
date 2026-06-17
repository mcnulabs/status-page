// SQLite store for the public status page: probe history + incidents.
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', '.data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'status.db'));
db.pragma('journal_mode = WAL');   // safe concurrent reads while the prober writes

db.exec(`
    CREATE TABLE IF NOT EXISTS checks (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        component TEXT NOT NULL,        -- public component key
        ts        INTEGER NOT NULL,     -- epoch ms
        up        INTEGER NOT NULL,     -- 1 / 0
        ms        INTEGER,              -- latency
        detail    TEXT                  -- optional note (e.g. "HTTP 503")
    );
    CREATE INDEX IF NOT EXISTS idx_checks_comp_ts ON checks (component, ts);

    CREATE TABLE IF NOT EXISTS incidents (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        component   TEXT,               -- affected component key (nullable = general)
        title       TEXT NOT NULL,
        status      TEXT NOT NULL,      -- investigating | identified | monitoring | resolved | maintenance
        impact      TEXT NOT NULL,      -- none | minor | major | critical
        source      TEXT NOT NULL,      -- 'auto' | 'manual'
        started_at  INTEGER NOT NULL,
        resolved_at INTEGER             -- null = ongoing
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_started ON incidents (started_at);

    CREATE TABLE IF NOT EXISTS incident_updates (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL,
        ts          INTEGER NOT NULL,
        status      TEXT NOT NULL,
        body        TEXT NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
    );
`);

// --- checks ---
const insCheck = db.prepare('INSERT INTO checks (component, ts, up, ms, detail) VALUES (?, ?, ?, ?, ?)');
export function recordCheck(component, ts, up, ms, detail) {
    insCheck.run(component, ts, up ? 1 : 0, ms ?? null, detail ?? null);
}

// Prune checks older than `days` to keep the DB small (run periodically).
const delOld = db.prepare('DELETE FROM checks WHERE ts < ?');
export function pruneChecks(days = 120) {
    delOld.run(Date.now() - days * 86400_000);
}

// Daily uptime buckets for a component over the last `days` days.
// Returns [{ day: 'YYYY-MM-DD', total, up, pct|null }] oldest→newest.
export function dailyUptime(component, days = 90) {
    const since = Date.now() - days * 86400_000;
    const rows = db.prepare(`
        SELECT date(ts/1000, 'unixepoch', 'localtime') AS day,
               COUNT(*) AS total,
               SUM(up)  AS up
        FROM checks
        WHERE component = ? AND ts >= ?
        GROUP BY day ORDER BY day
    `).all(component, since);
    const byDay = new Map(rows.map(r => [r.day, r]));
    // Fill the full window so the bar always shows `days` slots.
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400_000);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const r = byDay.get(key);
        out.push(r
            ? { day: key, total: r.total, up: r.up, pct: r.total ? Math.round((r.up / r.total) * 1000) / 10 : null }
            : { day: key, total: 0, up: 0, pct: null });
    }
    return out;
}

// Latest check for a component (current state).
export function latestCheck(component) {
    return db.prepare('SELECT * FROM checks WHERE component = ? ORDER BY ts DESC LIMIT 1').get(component);
}

// Overall uptime % over a window.
export function uptimePct(component, days = 90) {
    const since = Date.now() - days * 86400_000;
    const r = db.prepare('SELECT COUNT(*) total, SUM(up) up FROM checks WHERE component=? AND ts>=?').get(component, since);
    return r.total ? Math.round((r.up / r.total) * 1000) / 10 : null;
}

// Recent latency samples (ms) for a component — newest `limit` checks, oldest→newest.
// Used to draw the live sparkline on the public page.
export function recentLatency(component, limit = 48) {
    const rows = db.prepare(
        'SELECT ms FROM checks WHERE component=? AND ms IS NOT NULL ORDER BY ts DESC LIMIT ?'
    ).all(component, limit);
    return rows.map(r => r.ms).reverse();
}

// Aggregated daily uptime across several components (for a group's bar).
// A day counts as the AVERAGE of that day's per-component pct; null when no data.
export function groupDailyUptime(components, days = 90) {
    const per = components.map(c => dailyUptime(c, days));
    if (!per.length) return [];
    const out = [];
    for (let i = 0; i < days; i++) {
        const vals = per.map(p => p[i]?.pct).filter(v => v != null);
        out.push({ day: per[0][i].day, pct: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null });
    }
    return out;
}
export function groupUptimePct(components, days = 90) {
    const vals = components.map(c => uptimePct(c, days)).filter(v => v != null);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
}

// --- incidents ---
export function openAutoIncident(component, title) {
    // Only one ongoing auto-incident per component at a time.
    const existing = db.prepare(
        "SELECT * FROM incidents WHERE component=? AND source='auto' AND resolved_at IS NULL"
    ).get(component);
    if (existing) return existing;
    const now = Date.now();
    const info = db.prepare(`
        INSERT INTO incidents (component, title, status, impact, source, started_at)
        VALUES (?, ?, 'investigating', 'major', 'auto', ?)
    `).run(component, title, now);
    db.prepare('INSERT INTO incident_updates (incident_id, ts, status, body) VALUES (?, ?, ?, ?)')
        .run(info.lastInsertRowid, now, 'investigating', 'Automatically detected: component is down.');
    return db.prepare('SELECT * FROM incidents WHERE id=?').get(info.lastInsertRowid);
}

export function resolveAutoIncident(component) {
    const inc = db.prepare(
        "SELECT * FROM incidents WHERE component=? AND source='auto' AND resolved_at IS NULL"
    ).get(component);
    if (!inc) return null;
    const now = Date.now();
    db.prepare("UPDATE incidents SET status='resolved', resolved_at=? WHERE id=?").run(now, inc.id);
    db.prepare('INSERT INTO incident_updates (incident_id, ts, status, body) VALUES (?, ?, ?, ?)')
        .run(inc.id, now, 'resolved', 'Automatically resolved: component recovered.');
    return inc;
}

export function listIncidents(limit = 30) {
    const incs = db.prepare('SELECT * FROM incidents ORDER BY started_at DESC LIMIT ?').all(limit);
    const updStmt = db.prepare('SELECT ts, status, body FROM incident_updates WHERE incident_id=? ORDER BY ts');
    return incs.map(i => ({ ...i, resolved: i.resolved_at != null, updates: updStmt.all(i.id) }));
}

export function ongoingIncidents() {
    return db.prepare('SELECT * FROM incidents WHERE resolved_at IS NULL ORDER BY started_at DESC').all();
}

// --- manual incident management (admin) ---
export function createManualIncident({ component, title, status, impact, body }) {
    const now = Date.now();
    const info = db.prepare(`
        INSERT INTO incidents (component, title, status, impact, source, started_at)
        VALUES (?, ?, ?, ?, 'manual', ?)
    `).run(component || null, title, status || 'investigating', impact || 'minor', now);
    if (body) {
        db.prepare('INSERT INTO incident_updates (incident_id, ts, status, body) VALUES (?, ?, ?, ?)')
            .run(info.lastInsertRowid, now, status || 'investigating', body);
    }
    return db.prepare('SELECT * FROM incidents WHERE id=?').get(info.lastInsertRowid);
}

export function addIncidentUpdate(id, { status, body }) {
    const inc = db.prepare('SELECT * FROM incidents WHERE id=?').get(id);
    if (!inc) throw new Error('incident not found');
    const now = Date.now();
    const newStatus = status || inc.status;
    db.prepare('INSERT INTO incident_updates (incident_id, ts, status, body) VALUES (?, ?, ?, ?)')
        .run(id, now, newStatus, body || '');
    const resolved = newStatus === 'resolved';
    db.prepare('UPDATE incidents SET status=?, resolved_at=? WHERE id=?')
        .run(newStatus, resolved ? now : inc.resolved_at, id);
    return db.prepare('SELECT * FROM incidents WHERE id=?').get(id);
}

export function deleteIncident(id) {
    db.prepare('DELETE FROM incident_updates WHERE incident_id=?').run(id);
    return db.prepare('DELETE FROM incidents WHERE id=?').run(id).changes > 0;
}

// Read-only system probes. Every command is run via execFile with a fixed
// argument array (no shell, no user input interpolated) so there is no command
// injection surface. Each collector returns data or an { error } field — it
// never throws, so one failing probe can't take down the whole status response.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import tls from 'node:tls';
import { config } from './config.js';

const exec = promisify(execFile);

const SERVICE_RE = /^[a-zA-Z0-9._@-]+$/;   // valid systemd unit name (defense in depth)

// --- systemd services ---
async function serviceStatus(name) {
    if (!SERVICE_RE.test(name)) return { name, error: 'invalid name' };
    try {
        // is-active exits non-zero when not active, so capture both ways.
        let active = 'unknown';
        try {
            const { stdout } = await exec('systemctl', ['is-active', name], { timeout: 5000 });
            active = stdout.trim();
        } catch (e) {
            active = (e.stdout || '').trim() || 'inactive';
        }
        // Pull a couple of properties (uptime + sub-state) in one call.
        let activeEnterTs = null, sub = null, since = null;
        try {
            const { stdout } = await exec('systemctl',
                ['show', name, '--property=ActiveEnterTimestamp,SubState', '--no-pager'],
                { timeout: 5000 });
            for (const line of stdout.split('\n')) {
                const [k, ...rest] = line.split('=');
                const v = rest.join('=').trim();
                if (k === 'ActiveEnterTimestamp' && v) {
                    const t = Date.parse(v);
                    if (!Number.isNaN(t)) { activeEnterTs = t; since = v; }
                } else if (k === 'SubState') sub = v;
            }
        } catch (_) { /* properties optional */ }
        return {
            name,
            active,                 // "active" | "inactive" | "failed" | ...
            sub,                    // "running" | "exited" | "dead" | ...
            ok: active === 'active',
            uptimeSec: activeEnterTs ? Math.floor((Date.now() - activeEnterTs) / 1000) : null,
            since,
        };
    } catch (e) {
        return { name, error: e.message };
    }
}

export async function getServices() {
    return Promise.all(config.services.map(serviceStatus));
}

// --- disk usage (df) ---
export async function getDisk() {
    try {
        // -P = POSIX output (stable columns), -k = 1K blocks.
        const { stdout } = await exec('df', ['-Pk', config.diskPath], { timeout: 5000 });
        const lines = stdout.trim().split('\n');
        const cols = lines[lines.length - 1].split(/\s+/);
        // Filesystem 1K-blocks Used Available Capacity Mounted-on
        const totalK = parseInt(cols[1], 10);
        const usedK = parseInt(cols[2], 10);
        const availK = parseInt(cols[3], 10);
        const pct = totalK ? Math.round((usedK / totalK) * 100) : null;
        return {
            path: config.diskPath,
            totalBytes: totalK * 1024,
            usedBytes: usedK * 1024,
            availBytes: availK * 1024,
            usedPct: pct,
        };
    } catch (e) {
        return { path: config.diskPath, error: e.message };
    }
}

// --- memory + load (from os, no shell) ---
export function getSystem() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const [l1, l5, l15] = os.loadavg();
    return {
        hostname: os.hostname(),
        uptimeSec: Math.floor(os.uptime()),
        cpus: os.cpus().length,
        load: { '1m': +l1.toFixed(2), '5m': +l5.toFixed(2), '15m': +l15.toFixed(2) },
        mem: {
            totalBytes: total,
            usedBytes: used,
            usedPct: Math.round((used / total) * 100),
        },
    };
}

// --- TLS certificate expiry ---
// Parse notAfter out of a PEM cert using a TLS SecureContext (no openssl shell-out).
async function certExpiry(certPath) {
    try {
        const pem = await readFile(certPath, 'utf8');
        // Grab the first certificate block (the leaf).
        const match = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
        if (!match) return { path: certPath, error: 'no certificate found' };
        const x509 = new (await import('node:crypto')).X509Certificate(match[0]);
        const validTo = Date.parse(x509.validTo);
        const daysLeft = Math.floor((validTo - Date.now()) / (24 * 60 * 60 * 1000));
        return {
            path: certPath,
            subject: x509.subject?.split('\n')[0] || null,
            validTo: x509.validTo,
            daysLeft,
            ok: daysLeft > 14,
        };
    } catch (e) {
        return { path: certPath, error: e.message };
    }
}

export async function getCerts() {
    return Promise.all(config.certPaths.map(certExpiry));
}

// --- HTTP(s) health probes ---
async function probe(url) {
    const started = Date.now();
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 8000);
        const res = await fetch(url, { signal: ac.signal, redirect: 'manual' });
        clearTimeout(timer);
        let body = null;
        try { body = await res.json(); } catch (_) { /* not json */ }
        return {
            url,
            httpStatus: res.status,
            ok: res.status >= 200 && res.status < 300,
            ms: Date.now() - started,
            detail: body && typeof body === 'object'
                ? { status: body.status, idle: body.idle, uptimeSec: body.uptimeSec }
                : null,
        };
    } catch (e) {
        return { url, ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, ms: Date.now() - started };
    }
}

export async function getHealthProbes() {
    return Promise.all(config.healthUrls.map(probe));
}

// --- everything, in parallel ---
export async function collectAll() {
    const [services, disk, certs, health] = await Promise.all([
        getServices(), getDisk(), getCerts(), getHealthProbes(),
    ]);
    return {
        ts: Date.now(),
        system: getSystem(),
        services,
        disk,
        certs,
        health,
    };
}

// Periodic prober: hits each public component, records the result, and opens/
// closes auto-incidents based on consecutive failures. Runs in the same process.
import { config } from './config.js';
import { recordCheck, openAutoIncident, resolveAutoIncident, pruneChecks } from './db.js';
import { runProbe } from './probes.js';
import { notifyIncident } from './notify.js';

// Per-component consecutive-failure counters (in memory; the DB has the history).
const failStreak = new Map();
let timer = null;
let pruneTimer = null;
let running = false;

async function probeOne(c) {
    const started = Date.now();
    const { up, ms, detail } = await runProbe(c);
    recordCheck(c.key, started, up, ms, detail);

    // Auto-incident logic + fire notifications on the open/resolve transitions only.
    const prev = failStreak.get(c.key) || 0;
    if (up) {
        if (prev >= config.failsToIncident) {
            const inc = resolveAutoIncident(c.key);
            if (inc) notifyIncident('resolved', { component: c.label, title: `${c.label} recovered`, detail });
        }
        failStreak.set(c.key, 0);
    } else {
        const n = prev + 1;
        failStreak.set(c.key, n);
        if (n === config.failsToIncident) {
            openAutoIncident(c.key, `${c.label} is unreachable`);
            notifyIncident('opened', { component: c.label, title: `${c.label} is down`, detail });
        }
    }
    return { key: c.key, up, ms, detail };
}

async function probeAll() {
    if (running) return;
    running = true;
    try {
        await Promise.all(config.components.map(c => probeOne(c).catch(() => {})));
    } finally {
        running = false;
    }
}

export function startProber() {
    if (!config.components.length) {
        console.log('[prober] no components configured — public status page will be empty');
        return;
    }
    if (timer) clearInterval(timer);
    timer = setInterval(() => { probeAll().catch(() => {}); }, config.probeIntervalMs);
    setTimeout(() => { probeAll().catch(() => {}); }, 1500);   // first probe shortly after boot
    // Prune old checks once a day.
    if (pruneTimer) clearInterval(pruneTimer);
    pruneTimer = setInterval(() => { try { pruneChecks(120); } catch (_) {} }, 24 * 3600_000);
    console.log(`[prober] watching ${config.components.length} component(s) every ${config.probeIntervalMs / 1000}s`);
}

export function stopProber() {
    if (timer) clearInterval(timer);
    if (pruneTimer) clearInterval(pruneTimer);
    timer = pruneTimer = null;
}

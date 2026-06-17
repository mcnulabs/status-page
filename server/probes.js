// Probe registry. Each probe type takes a component and returns { up, ms, detail }.
// No probe throws — failures become { up:false, detail }.
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';

const BROWSERISH = {
    'User-Agent': 'Mozilla/5.0 (compatible; MCNU-StatusBot/1.0; +https://status.mcnu.ro)',
    'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
};

// --- HTTP: reachable = any non-5xx response ---
async function probeHttp(c) {
    const started = Date.now();
    try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 10_000);
        const res = await fetch(c.url, { signal: ac.signal, redirect: 'manual', headers: BROWSERISH });
        clearTimeout(t);
        return { up: res.status < 500, ms: Date.now() - started, detail: `HTTP ${res.status}` };
    } catch (e) {
        return { up: false, ms: Date.now() - started, detail: e.name === 'AbortError' ? 'timeout' : e.message };
    }
}

// --- HTTP keyword: up only if the body also contains an expected string ---
async function probeKeyword(c) {
    const started = Date.now();
    try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 10_000);
        const res = await fetch(c.url, { signal: ac.signal, headers: BROWSERISH });
        const body = await res.text();
        clearTimeout(t);
        const ms = Date.now() - started;
        if (res.status >= 500) return { up: false, ms, detail: `HTTP ${res.status}` };
        // Case-insensitive: a status keyword shouldn't break on capitalization.
        const found = body.toLowerCase().includes(c.keyword.toLowerCase());
        return { up: found, ms, detail: found ? `HTTP ${res.status}, keyword ok` : `keyword "${c.keyword}" missing` };
    } catch (e) {
        return { up: false, ms: Date.now() - started, detail: e.name === 'AbortError' ? 'timeout' : e.message };
    }
}

// --- TCP: connection opens within timeout ---
function probeTcp(c) {
    const started = Date.now();
    return new Promise(resolve => {
        const sock = new net.Socket();
        let done = false;
        const finish = (up, detail) => {
            if (done) return; done = true;
            try { sock.destroy(); } catch (_) {}
            resolve({ up, ms: Date.now() - started, detail });
        };
        sock.setTimeout(8000);
        sock.once('connect', () => finish(true, `connected ${c.host}:${c.port}`));
        sock.once('timeout', () => finish(false, 'timeout'));
        sock.once('error', (e) => finish(false, e.code || e.message));
        sock.connect(c.port, c.host);
    });
}

// --- TLS: connect + read cert expiry; down on handshake fail, "degraded" if <warnDays ---
function probeTls(c) {
    const started = Date.now();
    const warnDays = c.warnDays || 14;
    return new Promise(resolve => {
        let done = false;
        const finish = (up, detail, extra = {}) => {
            if (done) return; done = true;
            resolve({ up, ms: Date.now() - started, detail, ...extra });
        };
        const sock = tls.connect({
            host: c.host, port: c.port || 443, servername: c.host,
            timeout: 10_000, rejectUnauthorized: false,
        }, () => {
            const cert = sock.getPeerCertificate();
            if (!cert || !cert.valid_to) return finish(false, 'no certificate'), sock.destroy();
            const expMs = Date.parse(cert.valid_to);
            const daysLeft = Math.floor((expMs - Date.now()) / 86400_000);
            sock.destroy();
            // Up as long as the cert is still valid; the detail surfaces the warning.
            const ok = daysLeft > 0;
            const warn = daysLeft <= warnDays;
            finish(ok, ok ? `${daysLeft}d left${warn ? ' (renew soon!)' : ''}` : `expired ${-daysLeft}d ago`, { daysLeft, warn });
        });
        sock.setTimeout(10_000);
        sock.once('timeout', () => { try { sock.destroy(); } catch (_) {} finish(false, 'timeout'); });
        sock.once('error', (e) => finish(false, e.code || e.message));
    });
}

// --- DNS: domain resolves (optionally to an expected IP) ---
async function probeDns(c) {
    const started = Date.now();
    try {
        const addrs = await dns.resolve4(c.host);
        const ms = Date.now() - started;
        if (!addrs.length) return { up: false, ms, detail: 'no A records' };
        if (c.expect && !addrs.includes(c.expect)) {
            return { up: false, ms, detail: `resolved ${addrs.join(',')} (expected ${c.expect})` };
        }
        return { up: true, ms, detail: addrs.join(', ') };
    } catch (e) {
        return { up: false, ms: Date.now() - started, detail: e.code || e.message };
    }
}

const REGISTRY = {
    http: probeHttp,
    keyword: probeKeyword,
    tcp: probeTcp,
    tls: probeTls,
    dns: probeDns,
};

export async function runProbe(c) {
    const fn = REGISTRY[c.type] || probeHttp;
    try { return await fn(c); }
    catch (e) { return { up: false, ms: null, detail: e.message }; }
}

// Status dashboard front-end. Polls /api/status and renders cards.

const REFRESH_MS = 5000;
let timer = null;

function fmtBytes(n) {
    if (n == null) return '–';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtDuration(sec) {
    if (sec == null) return '–';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}
function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function bar(pct, warnAt = 80, critAt = 92) {
    const cls = pct >= critAt ? 'crit' : pct >= warnAt ? 'warn' : 'ok';
    return `<div class="bar"><div class="bar-fill ${cls}" style="width:${Math.min(100, pct || 0)}%"></div></div>`;
}
function dot(ok, warn = false) {
    return `<span class="dot ${ok ? 'green' : warn ? 'amber' : 'red'}"></span>`;
}

// Roll the whole picture into one verdict for the top banner.
function renderBanner(data) {
    const banner = document.getElementById('banner');
    const inner = document.getElementById('bannerInner');
    const dot = document.getElementById('bannerDot');
    const title = document.getElementById('bannerTitle');
    const sub = document.getElementById('bannerSub');

    const problems = [];
    (data.services || []).forEach(s => { if (s.error || !s.ok) problems.push(`${s.name} ${s.error ? 'error' : s.active}`); });
    (data.certs || []).forEach(c => { if (c.error) problems.push(`cert ${c.subject || c.path}: ${c.error}`); else if (c.daysLeft <= 14) problems.push(`${c.subject || 'cert'} expires in ${c.daysLeft}d`); });
    (data.health || []).forEach(h => { if (!h.ok) problems.push(`probe ${h.url} down`); });
    if (data.disk && data.disk.usedPct >= 90) problems.push(`disk ${data.disk.usedPct}% full`);

    const ok = problems.length === 0;
    banner.hidden = false;
    inner.className = 'banner-inner ' + (ok ? 'ok' : 'bad');
    dot.className = 'big-dot dot ' + (ok ? 'green' : 'red');
    title.textContent = ok ? 'ALL SYSTEMS NOMINAL' : `${problems.length} ISSUE${problems.length > 1 ? 'S' : ''}`;
    sub.textContent = ok ? 'Follow the gradient.' : problems.join(' · ');
}

function render(data) {
    renderBanner(data);
    const main = document.getElementById('dashboard');
    const sys = data.system || {};

    // System card
    const memPct = sys.mem?.usedPct ?? 0;
    const systemCard = `
        <section class="card">
            <h2><span class="nab">∇</span> System</h2>
            <div class="kv"><span>Host</span><b>${esc(sys.hostname)}</b></div>
            <div class="kv"><span>Uptime</span><b>${fmtDuration(sys.uptimeSec)}</b></div>
            <div class="kv"><span>Load (1/5/15m)</span><b>${sys.load ? `${sys.load['1m']} / ${sys.load['5m']} / ${sys.load['15m']}` : '–'} <small>(${sys.cpus} cpu)</small></b></div>
            <div class="kv col"><span>Memory ${memPct}% — ${fmtBytes(sys.mem?.usedBytes)} / ${fmtBytes(sys.mem?.totalBytes)}</span>${bar(memPct)}</div>
        </section>`;

    // Disk card
    const d = data.disk || {};
    const diskCard = `
        <section class="card">
            <h2><span class="nab">∇</span> Disk <small>${esc(d.path)}</small></h2>
            ${d.error
                ? `<div class="err-line">${esc(d.error)}</div>`
                : `<div class="kv col"><span>${d.usedPct}% used — ${fmtBytes(d.usedBytes)} / ${fmtBytes(d.totalBytes)} <small>(${fmtBytes(d.availBytes)} free)</small></span>${bar(d.usedPct)}</div>`}
        </section>`;

    // Services
    const svc = (data.services || []).map(s => {
        if (s.error) return `<div class="row">${dot(false)}<span class="row-name">${esc(s.name)}</span><span class="row-meta err-line">${esc(s.error)}</span></div>`;
        const warn = !s.ok && s.active !== 'failed';
        return `<div class="row">${dot(s.ok, warn)}<span class="row-name">${esc(s.name)}</span>
            <span class="row-meta">${esc(s.active)}${s.sub ? ' · ' + esc(s.sub) : ''}${s.ok && s.uptimeSec != null ? ' · up ' + fmtDuration(s.uptimeSec) : ''}</span></div>`;
    }).join('') || '<div class="muted">none configured</div>';
    const servicesCard = `<section class="card"><h2><span class="nab">∇</span> Services</h2>${svc}</section>`;

    // TLS certs
    const certs = (data.certs || []).map(c => {
        if (c.error) return `<div class="row">${dot(false)}<span class="row-name">${esc(c.subject || c.path)}</span><span class="row-meta err-line">${esc(c.error)}</span></div>`;
        const warn = c.daysLeft <= 14 && c.daysLeft > 3;
        const crit = c.daysLeft <= 3;
        return `<div class="row">${dot(!warn && !crit, warn)}<span class="row-name">${esc(c.subject || c.path)}</span>
            <span class="row-meta ${crit ? 'err-line' : ''}">${c.daysLeft}d left <small>(${esc(c.validTo)})</small></span></div>`;
    }).join('') || '<div class="muted">none configured</div>';
    const certsCard = `<section class="card"><h2><span class="nab">∇</span> TLS certificates</h2>${certs}</section>`;

    // Health probes
    const health = (data.health || []).map(h => {
        const meta = h.error
            ? `<span class="err-line">${esc(h.error)}</span>`
            : `${h.httpStatus} · ${h.ms}ms${h.detail?.idle ? ` · idle ${h.detail.idle.connected}/${h.detail.idle.total}` : ''}`;
        return `<div class="row">${dot(!!h.ok)}<span class="row-name">${esc(h.url)}</span><span class="row-meta">${meta}</span></div>`;
    }).join('') || '<div class="muted">none configured</div>';
    const healthCard = `<section class="card"><h2><span class="nab">∇</span> Health probes</h2>${health}</section>`;

    main.innerHTML = systemCard + diskCard + servicesCard + certsCard + healthCard;
    document.getElementById('updated').textContent = 'updated ' + new Date(data.ts).toLocaleTimeString();
}

async function load() {
    try {
        const res = await fetch('/api/status', { credentials: 'same-origin' });
        if (res.status === 401) { location.href = '/login.html'; return; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        render(await res.json());
    } catch (e) {
        document.getElementById('updated').textContent = 'error: ' + e.message;
    }
}

function startAuto() { stopAuto(); timer = setInterval(load, REFRESH_MS); }
function stopAuto() { if (timer) clearInterval(timer); timer = null; }

document.getElementById('refreshBtn').addEventListener('click', load);
document.getElementById('autoToggle').addEventListener('change', (e) => {
    if (e.target.checked) startAuto(); else stopAuto();
});
document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    location.href = '/login.html';
});
// Pause polling when the tab is hidden (save resources), resume on focus.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAuto();
    else if (document.getElementById('autoToggle').checked) { load(); startAuto(); }
});

// ============ INCIDENT MANAGEMENT (admin) ============
const incModal = document.getElementById('incidentsModal');

async function openIncidents() {
    incModal.hidden = false;
    // Populate component dropdown once.
    const sel = document.getElementById('incComponent');
    if (sel.options.length <= 1) {
        try {
            const { components } = await api('/api/components');
            components.forEach(c => {
                const o = document.createElement('option');
                o.value = c.key; o.textContent = c.label; sel.appendChild(o);
            });
        } catch (_) {}
    }
    loadIncidents();
}
function closeIncidents() { incModal.hidden = true; }

async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
    if (res.status === 401) { location.href = '/login.html'; throw new Error('unauth'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
}

async function loadIncidents() {
    const list = document.getElementById('incList');
    try {
        const { incidents } = await api('/api/incidents');
        if (!incidents.length) { list.innerHTML = '<div class="muted">No incidents yet.</div>'; return; }
        list.innerHTML = incidents.map(i => {
            const when = i.resolved
                ? `${new Date(i.started_at).toLocaleString()} → resolved`
                : `${new Date(i.started_at).toLocaleString()} · ongoing`;
            return `
                <div class="inc-item" data-id="${i.id}">
                    <div class="it-top">
                        <span class="dot ${i.resolved ? 'green' : 'red'}"></span>
                        <span class="it-title">${esc(i.title)}</span>
                        <span class="it-badge">${esc(i.source)}</span>
                        <span class="it-badge">${esc(i.status)}</span>
                    </div>
                    <div class="it-when">${esc(when)}</div>
                    <div class="it-actions">
                        ${i.resolved ? '' : `<button class="mini" data-act="resolve">Resolve</button>`}
                        <button class="mini danger" data-act="delete">Delete</button>
                    </div>
                </div>`;
        }).join('');
        list.querySelectorAll('.inc-item').forEach(el => {
            const id = el.dataset.id;
            el.querySelector('[data-act="resolve"]')?.addEventListener('click', async () => {
                try { await api(`/api/incidents/${id}/update`, { method: 'POST', body: JSON.stringify({ status: 'resolved', body: 'Resolved.' }) }); loadIncidents(); }
                catch (e) { alert('Failed: ' + e.message); }
            });
            el.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
                if (!confirm('Delete this incident permanently?')) return;
                try { await api(`/api/incidents/${id}`, { method: 'DELETE' }); loadIncidents(); }
                catch (e) { alert('Failed: ' + e.message); }
            });
        });
    } catch (e) {
        list.innerHTML = `<div class="err-line">${esc(e.message)}</div>`;
    }
}

document.getElementById('incidentsBtn').addEventListener('click', openIncidents);
document.getElementById('incidentsClose').addEventListener('click', closeIncidents);
incModal.addEventListener('click', (e) => { if (e.target === incModal) closeIncidents(); });
document.getElementById('incForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
        title: document.getElementById('incTitle').value.trim(),
        component: document.getElementById('incComponent').value || null,
        impact: document.getElementById('incImpact').value,
        status: document.getElementById('incStatus').value,
        body: document.getElementById('incBody').value.trim(),
    };
    if (!payload.title) return;
    try {
        await api('/api/incidents', { method: 'POST', body: JSON.stringify(payload) });
        document.getElementById('incForm').reset();
        loadIncidents();
    } catch (err) { alert('Failed: ' + err.message); }
});

// ============ PUSH ALERT SUBSCRIPTION (admin) ============
function urlBase64ToUint8Array(base64) {
    const pad = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}
function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
async function refreshAlertsBtn() {
    const btn = document.getElementById('alertsBtn');
    if (!btn) return;
    if (!pushSupported() || Notification.permission === 'denied') { btn.hidden = true; return; }
    try {
        const res = await fetch('/api/push/key', { credentials: 'same-origin' });
        const j = await res.json();
        if (!j.enabled) { btn.hidden = true; return; }
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        btn.hidden = !!existing;   // hide once subscribed
    } catch (_) { btn.hidden = true; }
}
async function enableAlerts() {
    if (!pushSupported()) { alert('Notifications not supported here'); return; }
    try {
        const { enabled, publicKey } = await (await fetch('/api/push/key', { credentials: 'same-origin' })).json();
        if (!enabled || !publicKey) { alert('Push not configured on server'); return; }
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { alert('Notifications blocked'); return; }
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
        await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
        document.getElementById('alertsBtn').hidden = true;
        alert('Alerts enabled on this device.');
    } catch (e) { alert('Could not enable alerts: ' + e.message); }
}
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(refreshAlertsBtn).catch(() => {});
}
document.getElementById('alertsBtn')?.addEventListener('click', enableAlerts);

load();
startAuto();

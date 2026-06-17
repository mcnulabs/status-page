// Public status page. Renders hero, summary stats, grouped components with
// pills + 90-day color bars + live latency sparklines, and the incident timeline.

const REFRESH_MS = 30000;

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtDate(ms) {
    return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDur(fromMs, toMs) {
    const s = Math.max(0, Math.floor(((toMs || Date.now()) - fromMs) / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

const OVERALL = {
    operational:  { cls: 'ok',   label: 'All Systems Operational', sub: 'Everything is running smoothly.' },
    degraded:     { cls: 'warn', label: 'Degraded Performance',    sub: 'Some systems are experiencing issues.' },
    major_outage: { cls: 'bad',  label: 'Major Outage',            sub: 'One or more systems are down.' },
    unknown:      { cls: 'warn', label: 'Collecting Data',         sub: 'Probes are warming up.' },
};
const STATE_PILL = {
    operational: { cls: 'op',    text: 'OPERATIONAL' },
    degraded:    { cls: 'deg',   text: 'DEGRADED' },
    down:        { cls: 'out',   text: 'OUTAGE' },
    major_outage:{ cls: 'out',   text: 'OUTAGE' },
    unknown:     { cls: 'maint', text: 'NO DATA' },
};
const IMPACT_CLR = { none: 'green', minor: 'amber', major: 'red', critical: 'red' };
const STATUS_LABEL = {
    investigating: 'Investigating', identified: 'Identified',
    monitoring: 'Monitoring', resolved: 'Resolved', maintenance: 'Maintenance',
};

// pct → per-day bar state.
function dayState(pct) {
    if (pct == null) return 'nodata';
    if (pct >= 99.5) return 'op';
    if (pct >= 90) return 'deg';
    return 'out';
}
function uptimeBar(history) {
    return `<div class="uptime-bar">` + history.map(d => {
        const st = dayState(d.pct);
        const tip = d.pct == null ? `${d.day} · no data` : `${d.day} · ${d.pct}% uptime`;
        return `<span class="ub ${st}" data-tip="${esc(tip)}"></span>`;
    }).join('') + `</div>`;
}

function componentRow(c) {
    const pill = STATE_PILL[c.current] || STATE_PILL.unknown;
    const sparkId = `spark-${c.key}`;
    const hasLatency = c.latency && c.latency.length > 1;
    return `
        <div class="comp">
            <div class="comp-head">
                <span class="comp-name">${esc(c.label)}</span>
                <span class="pill ${pill.cls} px">${pill.text}</span>
            </div>
            ${uptimeBar(c.history)}
            <div class="comp-foot">
                <span>90 days ago</span>
                <span class="comp-pct">${c.uptime90 != null ? c.uptime90 + '% uptime' : 'collecting…'}</span>
                <span>today</span>
            </div>
            ${hasLatency ? `<canvas class="spark" id="${sparkId}" data-points="${esc(c.latency.join(','))}"></canvas>` : ''}
        </div>`;
}

function render(data) {
    const page = document.getElementById('page');
    const ov = OVERALL[data.overall] || OVERALL.operational;
    const dotCls = ov.cls === 'ok' ? 'green' : ov.cls === 'warn' ? 'amber' : 'red';

    // Aggregate stats.
    const all = data.components || [];
    const withData = all.filter(c => c.uptime90 != null);
    const aggUptime = withData.length ? (withData.reduce((s, c) => s + c.uptime90, 0) / withData.length).toFixed(2) : null;
    const upCount = all.filter(c => c.current === 'operational').length;
    const activeIncidents = (data.incidents || []).filter(i => !i.resolved).length;

    const hero = `
        <section class="hero ${ov.cls}">
            <div class="hero-ring ${dotCls}"><span class="hero-core ${dotCls}"></span></div>
            <h1 class="hero-title">${esc(ov.label)}</h1>
            <p class="hero-sub">${esc(ov.sub)}</p>
        </section>`;

    const stats = `
        <section class="statrow">
            <div class="stat"><div class="stat-num">${upCount}<span class="stat-den">/${all.length}</span></div><div class="stat-lbl px">OPERATIONAL</div></div>
            <div class="stat"><div class="stat-num">${aggUptime != null ? aggUptime + '<span class="stat-den">%</span>' : '—'}</div><div class="stat-lbl px">90-DAY UPTIME</div></div>
            <div class="stat"><div class="stat-num ${activeIncidents ? 'bad' : ''}">${activeIncidents}</div><div class="stat-lbl px">ACTIVE INCIDENTS</div></div>
        </section>`;

    const legend = `
        <div class="legend">
            <span><i class="lg op"></i>Operational</span>
            <span><i class="lg deg"></i>Degraded</span>
            <span><i class="lg out"></i>Outage</span>
            <span><i class="lg nodata"></i>No data</span>
        </div>`;

    // Groups.
    const groups = data.groups || [{ name: null, status: data.overall, components: all }];
    const groupsHtml = groups.map(g => {
        const rows = g.components.map(componentRow).join('');
        if (!g.name) {
            // Ungrouped: just a card of components.
            return `<section class="card pub-card">${rows}</section>`;
        }
        const gp = STATE_PILL[g.status] || STATE_PILL.unknown;
        return `
            <section class="card pub-card group">
                <div class="group-head">
                    <h2 class="group-name">${esc(g.name)}</h2>
                    <span class="pill ${gp.cls} px">${gp.text}</span>
                </div>
                ${rows}
            </section>`;
    }).join('');

    // Incidents.
    const incs = data.incidents || [];
    const incidentsBlock = incs.length ? incs.map(i => {
        const clr = IMPACT_CLR[i.impact] || 'amber';
        const when = i.resolved
            ? `Resolved · lasted ${fmtDur(i.startedAt, i.resolvedAt)} · ${fmtDate(i.startedAt)}`
            : `Ongoing · started ${fmtDur(i.startedAt)} ago`;
        const updates = (i.updates || []).slice().reverse().map(u => `
            <div class="inc-update">
                <span class="iu-badge px ${u.status}">${esc(STATUS_LABEL[u.status] || u.status)}</span>
                <span class="iu-time">${fmtDate(u.ts)}</span>
                ${u.body ? `<p>${esc(u.body)}</p>` : ''}
            </div>`).join('');
        return `
            <div class="incident ${i.resolved ? 'resolved' : 'active'}">
                <div class="inc-rail"><span class="inc-node ${i.resolved ? 'green' : clr}"></span></div>
                <div class="inc-body">
                    <div class="inc-top">
                        <span class="inc-title">${esc(i.title)}</span>
                        ${i.componentLabel ? `<span class="inc-comp px">${esc(i.componentLabel)}</span>` : ''}
                    </div>
                    <div class="inc-when">${esc(when)}</div>
                    ${updates}
                </div>
            </div>`;
    }).join('') : `
        <div class="all-good"><span class="nab">∇</span><div><b>No incidents reported</b><span>All clear over the last 90 days.</span></div></div>`;
    const incidentsCard = `<section class="card pub-card"><h2 class="sec-h"><span class="nab">∇</span> Incident History</h2>${incidentsBlock}</section>`;

    page.innerHTML = hero + stats + legend + groupsHtml + incidentsCard;
    document.getElementById('updated').textContent = 'updated ' + new Date(data.ts).toLocaleTimeString();
    drawSparklines();
    wireTooltips();
}

// Draw a latency sparkline into each canvas from its data-points.
function drawSparklines() {
    document.querySelectorAll('canvas.spark').forEach(cv => {
        const pts = (cv.dataset.points || '').split(',').map(Number).filter(n => !Number.isNaN(n));
        if (pts.length < 2) return;
        const ctx = cv.getContext('2d');
        const dpr = devicePixelRatio || 1;
        const w = cv.clientWidth || 280, h = 34;
        cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const min = Math.min(...pts), max = Math.max(...pts), rng = (max - min) || 1;
        ctx.clearRect(0, 0, w, h);
        ctx.beginPath();
        pts.forEach((v, i) => {
            const x = i / (pts.length - 1) * w;
            const y = h - 3 - ((v - min) / rng) * (h - 6);
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.strokeStyle = '#22D3EE'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
        ctx.fillStyle = 'rgba(34,211,238,0.10)'; ctx.fill();
    });
}

let tipEl = null;
function wireTooltips() {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.appendChild(tipEl); }
    document.querySelectorAll('.ub[data-tip]').forEach(el => {
        el.addEventListener('mouseenter', () => {
            tipEl.textContent = el.dataset.tip; tipEl.style.opacity = '1';
            const r = el.getBoundingClientRect();
            tipEl.style.left = Math.round(r.left + r.width / 2) + 'px';
            tipEl.style.top = Math.round(r.top - 8) + 'px';
        });
        el.addEventListener('mouseleave', () => { tipEl.style.opacity = '0'; });
    });
}

async function load() {
    try {
        const res = await fetch('/api/public/status', { credentials: 'omit' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        render(await res.json());
    } catch (e) {
        document.getElementById('page').innerHTML = `<div class="loading">Status temporarily unavailable.</div>`;
    }
}

load();
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);

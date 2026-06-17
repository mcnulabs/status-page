// Alert dispatch. On incident open/resolve, fan out to every configured channel.
// Each channel is independent and guarded — one failing channel never blocks the rest.
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { sendPushToAll, isPushEnabled } from './push.js';

let mailer = null;
function getMailer() {
    const e = config.alerts.email;
    if (!e.host || !e.user || !e.pass || !e.from || !e.to) return null;
    if (!mailer) {
        mailer = nodemailer.createTransport({
            host: e.host, port: e.port, secure: e.secure,
            auth: { user: e.user, pass: e.pass },
        });
    }
    return mailer;
}

async function sendEmail(subject, text) {
    const m = getMailer();
    if (!m) return;
    const e = config.alerts.email;
    try {
        await m.sendMail({ from: e.from, to: e.to, subject, text });
        console.log('[alert] email sent');
    } catch (err) { console.warn('[alert] email failed:', err.message); }
}

async function sendSms(text) {
    const s = config.alerts.sms;
    // Only the API key + recipient are mandatory; the sender ID is auto-discovered.
    if (!s.apiKey || !s.to) return;
    try {
        const sender = await resolveSmsoSender(s);
        if (!sender) { console.warn('[alert] sms: no sender available on the SMSO account'); return; }
        const body = new URLSearchParams({ sender: String(sender), to: s.to, body: text, type: 'transactional', remove_special_chars: '1' });
        const res = await fetch('https://app.smso.ro/api/v1/send', {
            method: 'POST',
            headers: { 'X-Authorization': s.apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const j = await res.json().catch(() => ({}));
        if (j.status === 200) console.log(`[alert] sms sent (cost ${j.transaction_cost ?? '?'} eurocents)`);
        else console.warn('[alert] sms failed:', smsoError(j.status), j.message || '');
    } catch (err) { console.warn('[alert] sms failed:', err.message); }
}

// Cache the chosen sender so we don't hit /senders on every alert.
let smsoSenderCache = null;
async function resolveSmsoSender(s) {
    if (s.sender) return s.sender;            // explicit override wins
    if (smsoSenderCache) return smsoSenderCache;
    try {
        const res = await fetch('https://app.smso.ro/api/v1/senders', {
            headers: { 'X-Authorization': s.apiKey },
        });
        const list = await res.json().catch(() => []);
        if (Array.isArray(list) && list.length) {
            smsoSenderCache = list[0].id;     // first approved sender
            console.log(`[alert] sms: using sender "${list[0].name}" (id ${list[0].id})`);
            return smsoSenderCache;
        }
    } catch (err) { console.warn('[alert] sms: sender lookup failed:', err.message); }
    return null;
}

// Map SMSO's documented HTTP-style status codes to readable reasons.
function smsoError(code) {
    return ({
        400: 'invalid request',
        401: 'API key not valid',
        402: 'not enough credit',
        403: 'message contains blacklisted words',
        405: 'recipient unsubscribed',
        409: 'rate limit exceeded',
        422: 'international messages not allowed',
    })[code] || `status ${code}`;
}

async function sendPush(title, body, kind) {
    if (!isPushEnabled()) return;
    try { await sendPushToAll({ title, body, kind, url: 'https://status.mcnu.ro/' }); }
    catch (err) { console.warn('[alert] push failed:', err.message); }
}

// kind: 'opened' | 'resolved'. info: { component, title, detail }
export async function notifyIncident(kind, info) {
    const emoji = kind === 'opened' ? '🔴' : '🟢';
    const verb = kind === 'opened' ? 'DOWN' : 'RECOVERED';
    const title = `${emoji} ${info.component} ${verb}`;
    const line = `${info.title}${info.detail ? ` — ${info.detail}` : ''}`;
    const at = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Bucharest' });
    const fullText = `${line}\n\n${at}\nhttps://status.mcnu.ro/`;

    // Fire all channels in parallel; never throw.
    await Promise.allSettled([
        sendEmail(title, fullText),
        sendSms(`${title}. ${line}`),
        sendPush(title, line, kind),
    ]);
}

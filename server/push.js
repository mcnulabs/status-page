// Own Web Push for the status dashboard (separate from the webmail's push).
// Stores subscriptions in .data/push-subscriptions.json and sends VAPID notifications.
import webpush from 'web-push';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic, readJsonArray } from './store-util.js';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const subsFile = path.join(__dirname, '..', '.data', 'push-subscriptions.json');

let subscriptions = [];
let enabled = false;

export function initPush() {
    const { publicKey, privateKey, subject } = config.alerts.push;
    if (!publicKey || !privateKey) { console.log('[push] disabled (no VAPID keys)'); return false; }
    webpush.setVapidDetails(subject, publicKey, privateKey);
    enabled = true;
    subscriptions = readJsonArray(subsFile, 'push', Date.now());
    console.log(`[push] enabled (${subscriptions.length} subscriptions)`);
    return true;
}

export function isPushEnabled() { return enabled; }
export function publicKey() { return config.alerts.push.publicKey; }

function persist() {
    try { writeJsonAtomic(subsFile, subscriptions); }
    catch (e) { console.error('[push] persist failed:', e.message); }
}

export function addSubscription(sub) {
    if (!sub || !sub.endpoint) return;
    if (subscriptions.some(s => s.endpoint === sub.endpoint)) return;
    subscriptions.push({ endpoint: sub.endpoint, keys: sub.keys, addedAt: Date.now() });
    persist();
}
export function removeSubscription(endpoint) {
    const before = subscriptions.length;
    subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
    if (subscriptions.length !== before) persist();
}

export async function sendPushToAll(payload) {
    if (!enabled || !subscriptions.length) return;
    const body = JSON.stringify(payload);
    const dead = [];
    await Promise.all(subscriptions.map(async (sub) => {
        try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { TTL: 300 }); }
        catch (err) {
            const code = err.statusCode;
            if (code === 404 || code === 410) dead.push(sub.endpoint);
            else console.warn('[push] send failed:', code || err.message);
        }
    }));
    if (dead.length) { subscriptions = subscriptions.filter(s => !dead.includes(s.endpoint)); persist(); }
}

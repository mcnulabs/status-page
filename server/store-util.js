// Atomic JSON store helpers (write-tmp-then-rename; corruption-safe load).
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function writeJsonAtomic(file, data) {
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, file);
}

export function readJsonArray(file, label, nowTs) {
    let raw;
    try { raw = readFileSync(file, 'utf8'); }
    catch (_) { return []; }
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v : [];
    } catch (e) {
        const backup = `${file}.corrupt-${nowTs || 'unknown'}`;
        try { renameSync(file, backup); } catch (_) {}
        console.error(`[${label}] store was corrupt — preserved as ${backup} and starting empty.`);
        return [];
    }
}

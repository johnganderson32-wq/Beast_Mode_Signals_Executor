'use strict';

// Live log stream — disk persistence + SSE broadcast.
// Ported from EvilSignals-Executor/src/logger.js, adapted to BEAST_LOG_DIR.
//
// Write targets (every log line hits all three):
//   1. original console (stdout/stderr) — preserves terminal visibility
//   2. daily file at <LOG_DIR>/executor-YYYY-MM-DD.log — audit trail, survives restart
//   3. in-memory ring buffer (last REPLAY_LINES) — replayed to new SSE clients on connect
//   4. all connected SSE clients — live dashboard pane
//
// Daily files older than 7 days are pruned on rotation. ET-zoned timestamps
// so the file name matches the trading session the trader actually remembers.

const fs   = require('fs');
const path = require('path');
const { LOG_DIR } = require('./paths');

const REPLAY_LINES = 200;
const RETAIN_DAYS  = 7;

// ── SSE clients + replay ring buffer ─────────────────────────────────────────
const clients = [];
const ringBuf = [];  // last N formatted lines (with ET timestamp prefix)

function ringPush(line) {
    ringBuf.push(line);
    if (ringBuf.length > REPLAY_LINES) ringBuf.shift();
}

// ── ET timestamp helpers ─────────────────────────────────────────────────────
function etParts(now) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).formatToParts(now || new Date());
}
function etDateStr() {
    const p = etParts();
    const g = t => p.find(x => x.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
}
function etTimestamp() {
    const p = etParts();
    const g = t => p.find(x => x.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')} ET`;
}

// ── Daily file stream (rotates at ET midnight) ───────────────────────────────
let currentDate   = null;
let currentStream = null;

function ensureLogDir() {
    try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

function pruneOldLogs() {
    const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
    try {
        for (const f of fs.readdirSync(LOG_DIR)) {
            if (!f.startsWith('executor-') || !f.endsWith('.log')) continue;
            const d = new Date(f.slice(9, 19));  // YYYY-MM-DD out of executor-YYYY-MM-DD.log
            if (!isNaN(d.getTime()) && d.getTime() < cutoff) {
                try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch {}
            }
        }
    } catch {}
}

function getStream() {
    const today = etDateStr();
    if (today !== currentDate || !currentStream) {
        if (currentStream) { try { currentStream.end(); } catch {} }
        ensureLogDir();
        currentDate   = today;
        currentStream = fs.createWriteStream(
            path.join(LOG_DIR, `executor-${today}.log`),
            { flags: 'a' }
        );
        currentStream.on('error', err => {
            // Use original console so we never recurse through our own patched console
            origErr('[log-stream] file write error:', err.message);
        });
        pruneOldLogs();
    }
    return currentStream;
}

// ── Broadcast to SSE clients + ring buffer + disk ───────────────────────────
function writeLine(formatted) {
    ringPush(formatted);
    try { getStream().write(formatted + '\n'); } catch {}
    const msg = `data: ${JSON.stringify(formatted)}\n\n`;
    for (let i = clients.length - 1; i >= 0; i--) {
        try { clients[i].write(msg); } catch { clients.splice(i, 1); }
    }
}

// Public: explicit free-form line (pre-formatted by caller)
function addLine(text) {
    const line = `${etTimestamp()} ${text}`;
    writeLine(line);
}

// Public: SSE registration — replays ring buffer so Ctrl+R sees recent history
function addClient(res) {
    res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection:      'keep-alive',
    });
    res.write('\n');

    // Replay the last REPLAY_LINES so the trader scanning the pane after a
    // reload still sees what executed. Ordered oldest→newest.
    for (const line of ringBuf) {
        try { res.write(`data: ${JSON.stringify(line)}\n\n`); } catch { return; }
    }

    clients.push(res);
    res.on('close', () => {
        const idx = clients.indexOf(res);
        if (idx !== -1) clients.splice(idx, 1);
    });
}

// ── Console monkey-patch ────────────────────────────────────────────────────
// Captures every console.log/warn/error call, formats with ET timestamp + level tag,
// writes to disk + SSE + ring buffer. Preserves original console output.
const origLog  = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origErr  = console.error.bind(console);

function formatArgs(args) {
    return args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
}

function patched(level, origFn) {
    return function (...args) {
        origFn(...args);
        const text = formatArgs(args);
        const line = level
            ? `${etTimestamp()} [${level}] ${text}`
            : `${etTimestamp()} ${text}`;
        writeLine(line);
    };
}

console.log   = patched(null,  origLog);
console.warn  = patched('WARN', origWarn);
console.error = patched('ERR',  origErr);

module.exports = { addClient, addLine };

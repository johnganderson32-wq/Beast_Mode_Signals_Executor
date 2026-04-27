'use strict';

// Append-only audit log of webhook signals that Pine v4.2's matrix /
// Power-Window stack rejected (filter_status MATRIX_SKIP or PW_SIZE_0).
// These are pure telemetry — no order, no journal, no risk-state mutation —
// consumed by EAI's matrix-vs-live accuracy analyzer.
//
// Schema: { _v: 1, receivedAt, filter_status, payload }. Full payload preserved
// verbatim so the analyzer can reconstruct simulated $ P&L from price, stop,
// direction, barCloseMs, cell_id, macro_transition, entry_zone_side.

const fs   = require('fs');
const path = require('path');
const { LOG_DIR } = require('./paths');

const FILTERED_FILE = path.join(LOG_DIR, 'filtered_signals.jsonl');

function logFilteredSignal({ payload, filter_status, receivedAt }) {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        const entry = {
            _v: 1,
            receivedAt: receivedAt || new Date().toISOString(),
            filter_status,
            payload,
        };
        fs.appendFileSync(FILTERED_FILE, JSON.stringify(entry) + '\n');
    } catch (e) {
        console.warn(`[filteredSignals] log write failed: ${e.message}`);
    }
}

module.exports = { logFilteredSignal };

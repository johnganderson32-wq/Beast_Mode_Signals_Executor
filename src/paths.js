'use strict';

// Single source of truth for persistence file locations.
//
// Production: resolves to <repo>/logs/ (the default).
// Tests:      set BEAST_LOG_DIR to an os.tmpdir() path BEFORE requiring any
//             src/* module, so tests never touch real audit files (trades.jsonl,
//             signals.jsonl, daily-pnl.json, settings.json, .token.json). Our
//             P&L audits depend on these being clean.
//
// Resolved once at first require. Tests that need a fresh directory should
// clear the require cache after setting the env var, or use a child process.

const path = require('path');

const LOG_DIR = process.env.BEAST_LOG_DIR
    ? path.resolve(process.env.BEAST_LOG_DIR)
    : path.join(__dirname, '..', 'logs');

module.exports = { LOG_DIR };

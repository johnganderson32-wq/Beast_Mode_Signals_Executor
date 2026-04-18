'use strict';

require('dotenv').config();

// Log stream must be required early to monkey-patch console before other modules log
require('./log-stream');

const express    = require('express');
const path       = require('path');
const settings   = require('./settings');
const risk       = require('./risk');
const { createWebhookRouter }   = require('./webhook');
const { createDashboardRouter } = require('./dashboard');
const db         = require('./db');

risk.restorePnlState();

const PORT = parseInt(process.env.PORT || '3100', 10);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/webhook', createWebhookRouter());
app.use('/api',     createDashboardRouter());

// Serve dashboard SPA on all non-API routes
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const px = require('./projectx');

app.listen(PORT, async () => {
    console.log(`[beast-executor] Listening on http://localhost:${PORT}`);
    console.log(`[beast-executor] Webhook endpoint: POST /webhook/signal`);
    console.log(`[beast-executor] Trading: ${risk.isTradingEnabled() ? 'ON' : 'OFF'}`);
    // Authenticate with ProjectX on boot so the dashboard dot goes green
    try {
        await px.authenticate();
    } catch (e) {
        console.error(`[beast-executor] ProjectX auth failed on boot: ${e.message}`);
    }
});

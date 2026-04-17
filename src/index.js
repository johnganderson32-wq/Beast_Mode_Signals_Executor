'use strict';

require('dotenv').config();

const express    = require('express');
const path       = require('path');
const { createWebhookRouter } = require('./webhook');
const { createDashboardRouter } = require('./dashboard');
const db         = require('./db');

const PORT = parseInt(process.env.PORT || '3100', 10);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/webhook', createWebhookRouter());
app.use('/api',     createDashboardRouter());

// Serve dashboard SPA on all non-API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`[beast-executor] Listening on http://localhost:${PORT}`);
    console.log(`[beast-executor] Webhook endpoint: POST /webhook/signal`);
});

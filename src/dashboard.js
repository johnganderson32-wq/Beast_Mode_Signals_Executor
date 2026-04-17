'use strict';

const express = require('express');
const db      = require('./db');

function createDashboardRouter() {
    const router = express.Router();

    // GET /api/trades — all trades
    router.get('/trades', (req, res) => {
        res.json(db.getAll());
    });

    // GET /api/trades/open — open positions
    router.get('/trades/open', (req, res) => {
        res.json(db.getOpen());
    });

    // GET /api/stats — analytics
    router.get('/stats', (req, res) => {
        res.json(db.getStats());
    });

    // PATCH /api/trades/:id — manual outcome update
    // Body: { status, exitPrice, exitTime }
    //   status: TP1 | TARGET | STOPPED | MANUAL
    router.patch('/trades/:id', (req, res) => {
        const id    = parseInt(req.params.id, 10);
        const trade = db.getAll().find(t => t.id === id);
        if (!trade) return res.status(404).json({ error: 'Trade not found' });

        const { status, exitPrice, exitTime } = req.body;
        if (!['TP1', 'TARGET', 'STOPPED', 'MANUAL'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const now  = exitTime || new Date().toISOString();
        const exit = exitPrice != null ? parseFloat(exitPrice) : null;

        // rMultiple: (exit - entry) / rDist, signed for direction
        let rMultiple = null;
        let pnlPoints = null;
        if (exit !== null && trade.rDist > 0) {
            const raw = exit - trade.entryPrice;
            pnlPoints  = trade.direction === 'bullish' ? raw : -raw;
            rMultiple  = Math.round((pnlPoints / trade.rDist) * 100) / 100;
            pnlPoints  = Math.round(pnlPoints * 100) / 100;
        }

        const updated = db.update(id, { status, exitPrice: exit, exitTime: now, rMultiple, pnlPoints });
        res.json(updated);
    });

    return router;
}

module.exports = { createDashboardRouter };

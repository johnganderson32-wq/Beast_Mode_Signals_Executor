'use strict';
// Emergency flatten on account 13146982 for MNQ M26.
// Usage: DRY=1 node scripts/emergency_flatten.js  (dry-run)
//        node scripts/emergency_flatten.js        (live flatten)

require('dotenv').config();
const axios = require('axios');
const px = require('../src/projectx');

const DRY = process.env.DRY === '1';
const CONTRACT = 'CON.F.US.MNQ.M26';
const ACCT = 13146982;

(async () => {
    await px.authenticate();
    const token = px.getToken();

    const pR = await axios.post('https://api.topstepx.com/api/Position/searchOpen',
        { accountId: ACCT },
        { headers: { Authorization: `Bearer ${token}` } });
    const positions = pR.data.positions || [];
    const pos = positions.find(p => p.contractId === CONTRACT);
    if (!pos || pos.size === 0) {
        console.log(`No open position on ${CONTRACT} for account ${ACCT} — nothing to do.`);
        return;
    }

    console.log(`FOUND: type=${pos.type === 1 ? 'LONG' : 'SHORT'} size=${pos.size} avg=${pos.averagePrice}`);
    console.log(DRY ? '[DRY] would flatten' : '[LIVE] flattening now');
    if (DRY) return;

    // Opposing market order: if position is SHORT (type 2), BUY to close (side 0)
    //                       if position is LONG  (type 1), SELL to close (side 1)
    const closeSide = pos.type === 2 ? 0 : 1;
    const body = {
        accountId: ACCT,
        contractId: CONTRACT,
        type: 2,
        side: closeSide,
        size: pos.size,
        customTag: `BEAST:EMERGENCY_FLAT:${Date.now()}`,
    };
    const r = await axios.post('https://api.topstepx.com/api/Order/place', body,
        { headers: { Authorization: `Bearer ${token}` } });
    console.log('Close order response:', JSON.stringify(r.data, null, 2));

    // Cancel any remaining working orders on this contract
    const oR = await axios.post('https://api.topstepx.com/api/Order/searchOpen',
        { accountId: ACCT },
        { headers: { Authorization: `Bearer ${token}` } });
    const working = (oR.data.orders || []).filter(o => o.contractId === CONTRACT);
    for (const o of working) {
        console.log(`Cancelling working order ${o.id} ${o.customTag}`);
        try {
            await axios.post('https://api.topstepx.com/api/Order/cancel',
                { accountId: ACCT, orderId: o.id },
                { headers: { Authorization: `Bearer ${token}` } });
        } catch (e) {
            console.warn(`  cancel failed: ${e.message}`);
        }
    }
})().catch(e => { console.error('ERROR:', e.message, e.response?.data); process.exit(1); });

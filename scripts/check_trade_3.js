'use strict';
require('dotenv').config();
const axios = require('axios');
const px = require('../src/projectx');

(async () => {
    await px.authenticate();
    const token = px.getToken();
    const acctId = 13146982;  // BEAST trading account from RTC subscription log
    console.log('Querying BEAST accountId=', acctId);

    // 1. Open positions
    const pR = await axios.post('https://api.topstepx.com/api/Position/searchOpen',
        { accountId: acctId },
        { headers: { Authorization: `Bearer ${token}` } });
    console.log('\n=== OPEN POSITIONS ===');
    console.log(JSON.stringify(pR.data.positions || pR.data.results || [], null, 2));

    // 2. Open orders
    const oR = await axios.post('https://api.topstepx.com/api/Order/searchOpen',
        { accountId: acctId },
        { headers: { Authorization: `Bearer ${token}` } });
    console.log('\n=== OPEN ORDERS ===');
    console.log(JSON.stringify(oR.data.orders || oR.data.results || [], null, 2));

    // 3. All orders since 11am ET today
    const orderR = await axios.post('https://api.topstepx.com/api/Order/search',
        { accountId: acctId, startTimestamp: '2026-04-21T15:00:00.000Z', endTimestamp: '2026-04-21T21:00:00.000Z' },
        { headers: { Authorization: `Bearer ${token}` } });
    const orders = orderR.data.orders || [];
    console.log(`\n=== ALL ORDERS 15:00-21:00Z on acct ${acctId}: ${orders.length} ===`);
    for (const o of orders) {
        console.log(`  id=${o.id} ${o.customTag} status=${o.status} type=${o.type} side=${o.side} size=${o.size} fill=${o.fillVolume}@${o.filledPrice} updated=${o.updateTimestamp}`);
    }

    // 4. Executions (actual fills) in the same window
    const trR = await axios.post('https://api.topstepx.com/api/Trade/search',
        { accountId: acctId, startTimestamp: '2026-04-21T15:00:00.000Z', endTimestamp: '2026-04-21T21:00:00.000Z' },
        { headers: { Authorization: `Bearer ${token}` } });
    const trades = trR.data.trades || trR.data.results || [];
    console.log(`\n=== EXECUTIONS 15:00-21:00Z on acct ${acctId}: ${trades.length} ===`);
    for (const t of trades) {
        console.log(`  ${t.creationTimestamp}  orderId=${t.orderId}  side=${t.side}  size=${t.size}  price=${t.price}  pnl=${t.profitAndLoss}`);
    }
})().catch(e => { console.error('ERROR:', e.message, e.response?.data); process.exit(1); });

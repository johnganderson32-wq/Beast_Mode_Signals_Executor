'use strict';
require('dotenv').config();
const px = require('../src/projectx');

(async () => {
    await px.authenticate();
    const acctId = parseInt(process.env.PROJECTX_ACCOUNT_ID || require('../src/settings').get('accountId'), 10);

    const positions = await px.getOpenPositions(acctId);
    console.log('\n=== OPEN POSITIONS ===');
    console.log(JSON.stringify(positions, null, 2));

    const openOrders = await px.getOpenOrders(acctId);
    console.log('\n=== OPEN ORDERS ===');
    console.log(JSON.stringify(openOrders, null, 2));
})().catch(e => { console.error(e.message); process.exit(1); });

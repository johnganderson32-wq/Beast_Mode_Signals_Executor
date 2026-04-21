'use strict';
// Live paper test of the modifyOrder primitive on PRAC account.
// Places a stop order far from market (won't trigger), shrinks its size,
// verifies at broker, cancels. Zero market risk.
//
// Usage: node scripts/live_modify_test.js

require('dotenv').config();
const axios = require('axios');
const px = require('../src/projectx');

const PRAC_ACCT = parseInt(process.env.PROJECTX_ACCOUNT_ID, 10);  // PRAC from .env
const CONTRACT  = process.env.NQ_CONTRACT_ID || 'CON.F.US.MNQ.M26';
const STOP_PRICE_FAR_BELOW = 20000;  // MNQ is ~26700 currently; 20000 will never trigger
const INITIAL_SIZE = 3;
const TARGET_SIZE  = 1;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
    await px.authenticate();
    const token = px.getToken();
    console.log(`PRAC account: ${PRAC_ACCT}`);
    console.log(`Contract:     ${CONTRACT}`);

    // 1. Place a SELL stop 6700 points below market (safe — won't trigger)
    console.log(`\n[1] Placing ${INITIAL_SIZE}ct SELL stop @ ${STOP_PRICE_FAR_BELOW}...`);
    const placeRes = await axios.post('https://api.topstepx.com/api/Order/place', {
        accountId: PRAC_ACCT,
        contractId: CONTRACT,
        type: 4,           // Stop
        side: 1,           // Sell
        size: INITIAL_SIZE,
        stopPrice: STOP_PRICE_FAR_BELOW,
        customTag: `BEAST:TEST:${Date.now()}`,
    }, { headers: { Authorization: `Bearer ${token}` } });

    if (!placeRes.data?.success) {
        console.error('Place failed:', placeRes.data);
        process.exit(1);
    }
    const orderId = placeRes.data.orderId ?? placeRes.data.id;
    console.log(`    placed orderId=${orderId}`);

    // 2. Fetch it back to confirm size
    await sleep(500);
    let check = await axios.post('https://api.topstepx.com/api/Order/searchOpen',
        { accountId: PRAC_ACCT },
        { headers: { Authorization: `Bearer ${token}` } });
    let found = (check.data.orders || []).find(o => Number(o.id) === Number(orderId));
    console.log(`[2] Broker says: size=${found?.size} stopPrice=${found?.stopPrice}`);
    if (!found || found.size !== INITIAL_SIZE) {
        console.error('Initial size mismatch — aborting');
        process.exit(1);
    }

    // 3. Call our modifyOrder primitive to shrink to target size
    console.log(`\n[3] Calling px.modifyOrder(${orderId}, { size: ${TARGET_SIZE} }, ${PRAC_ACCT})...`);
    try {
        await px.modifyOrder(orderId, { size: TARGET_SIZE }, PRAC_ACCT);
        console.log('    modifyOrder returned success');
    } catch (e) {
        console.error('    modifyOrder threw:', e.message);
        // still try to clean up
        await axios.post('https://api.topstepx.com/api/Order/cancel',
            { accountId: PRAC_ACCT, orderId },
            { headers: { Authorization: `Bearer ${token}` } });
        process.exit(1);
    }

    // 4. Re-fetch and verify
    await sleep(500);
    check = await axios.post('https://api.topstepx.com/api/Order/searchOpen',
        { accountId: PRAC_ACCT },
        { headers: { Authorization: `Bearer ${token}` } });
    found = (check.data.orders || []).find(o => Number(o.id) === Number(orderId));
    console.log(`\n[4] Broker says after modify: size=${found?.size} stopPrice=${found?.stopPrice}`);

    const ok = found && found.size === TARGET_SIZE;
    console.log(`    ${ok ? 'PASS' : 'FAIL'} — expected size=${TARGET_SIZE}, got size=${found?.size}`);

    // 5. Cancel the test order
    console.log(`\n[5] Cancelling test order ${orderId}...`);
    await axios.post('https://api.topstepx.com/api/Order/cancel',
        { accountId: PRAC_ACCT, orderId },
        { headers: { Authorization: `Bearer ${token}` } });
    console.log('    cancelled.');

    console.log(`\n${ok ? '✓ modifyOrder primitive works on PRAC broker' : '✗ FAILED — do not rely on the fix until this is resolved'}`);
    process.exit(ok ? 0 : 1);
})().catch(e => {
    console.error('ERROR:', e.message, e.response?.data);
    process.exit(1);
});

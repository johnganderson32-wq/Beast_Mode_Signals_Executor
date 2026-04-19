'use strict';

// Fetch active TopstepX accounts and print masked dropdown labels.
// CLI:    node scripts/fetchAccounts.js
// Module: const { fetchAccounts, maskAccount } = require('./scripts/fetchAccounts');

require('dotenv').config();
const axios = require('axios');

const API_URL = (process.env.PROJECTX_API_URL || 'https://api.topstepx.com/api').replace(/\/$/, '');

function maskAccount(name) {
    if (!name) return name;
    const parts = String(name).trim().split('-');
    const prefix = parts[0] || name;
    const tail = parts[parts.length - 1] || '';
    const last4 = tail.length >= 4 ? tail.slice(-4) : tail;
    return last4 ? `${prefix} ...${last4}` : prefix;
}

async function fetchAccounts({ onlyActiveAccounts = true } = {}) {
    const username = process.env.PROJECTX_USERNAME;
    const apiKey   = process.env.PROJECTX_API_KEY;
    if (!username || !apiKey) throw new Error('PROJECTX_USERNAME and PROJECTX_API_KEY must be set in .env');

    const { data: auth } = await axios.post(`${API_URL}/Auth/loginKey`, { userName: username, apiKey });
    if (!auth || !auth.token) throw new Error(`Auth failed: ${JSON.stringify(auth)}`);

    const { data } = await axios.post(
        `${API_URL}/Account/search`,
        { onlyActiveAccounts },
        { headers: { Authorization: `Bearer ${auth.token}` } }
    );

    const accounts = (data && data.accounts) || [];
    return accounts.map(a => ({ ...a, label: maskAccount(a.name) }));
}

module.exports = { fetchAccounts, maskAccount };

if (require.main === module) {
    fetchAccounts({ onlyActiveAccounts: true })
        .then(accts => {
            if (!accts.length) { console.log('No active accounts returned.'); return; }
            console.log(`\nActive TopstepX accounts (${accts.length}):\n`);
            for (const a of accts) {
                console.log(`  ${a.label.padEnd(16)}  id=${a.id}  bal=$${Number(a.balance).toLocaleString()}  canTrade=${a.canTrade}`);
            }
            console.log('\nDropdown wiring: option.value = a.id, option.textContent = a.label\n');
        })
        .catch(e => { console.error('ERROR:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
}

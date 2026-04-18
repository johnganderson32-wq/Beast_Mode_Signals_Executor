'use strict';

// In-memory settings store with defaults from process.env

const store = {
    tradingEnabled:       false,
    nqBias:               'ALL',     // ALL | LONG | SHORT
    accountId:            process.env.PROJECTX_ACCOUNT_ID || '',
    nqContractId:         process.env.NQ_CONTRACT_ID      || '',
    gcContractId:         process.env.GC_CONTRACT_ID      || '',
    esContractId:         process.env.ES_CONTRACT_ID      || '',
    nqContracts:          parseInt(process.env.NQ_CONTRACTS || '2', 10),
    mnqContracts:         parseInt(process.env.NQ_CONTRACTS || '2', 10),
    gcContracts:          parseInt(process.env.GC_CONTRACTS || '1', 10),
    mgcContracts:         parseInt(process.env.GC_CONTRACTS || '1', 10),
    esContracts:          0,
    mesContracts:         0,
    dailyLossCap:         0,
    dailyProfitCap:       0,
    sessionClose:         '',
    consecutiveLossLimit: 0,
    pauseDuration:        0,
    atmStrategy:          'standard',   // standard | momentum
    perTradeLossCap:      0,
    dynamicSizing:        false,
};

function get(key) {
    return store[key];
}

function set(key, value) {
    if (!(key in store)) return;
    store[key] = value;
}

function getAll() {
    return { ...store };
}

function merge(partial) {
    for (const [k, v] of Object.entries(partial)) {
        if (k in store) store[k] = v;
    }
}

module.exports = { get, set, getAll, merge };

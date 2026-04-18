'use strict';

// Contract specifications table.
// $/pt is derived as tickValue / tickSize.
// Keyed by the product code embedded in ProjectX contract IDs (CON.F.US.<CODE>.<EXPIRY>).
const SPECS = {
    ENQ: { tickSize: 0.25, tickValue: 5.00,  family: 'NQ' },   // $20/pt
    MNQ: { tickSize: 0.25, tickValue: 0.50,  family: 'NQ' },   //  $2/pt
    GC:  { tickSize: 0.10, tickValue: 10.00, family: 'GC' },   // $100/pt
    MGC: { tickSize: 0.10, tickValue: 1.00,  family: 'GC' },   // $10/pt
    ES:  { tickSize: 0.25, tickValue: 12.50, family: 'ES' },   // $50/pt
    MES: { tickSize: 0.25, tickValue: 1.25,  family: 'ES' },   //  $5/pt
};

// Map any TV ticker variant or free-form instrument string to a product family.
const FAMILY_MAP = {
    NQ: 'NQ', MNQ: 'NQ', ENQ: 'NQ',
    GC: 'GC', MGC: 'GC',
    ES: 'ES', MES: 'ES',
};

function normalizeInstrument(raw) {
    const upper = String(raw || '').toUpperCase().trim();
    if (FAMILY_MAP[upper]) return FAMILY_MAP[upper];
    // Strip TV continuous contract suffix ("NQ1!", "GC2!")
    let clean = upper.replace(/\d+!$/, '');
    if (FAMILY_MAP[clean]) return FAMILY_MAP[clean];
    // Strip TV expiry suffix ("MNQM2026", "MGCQ2025")
    clean = upper.replace(/[FGHJKMNQUVXZ]\d{4}$/, '');
    if (FAMILY_MAP[clean]) return FAMILY_MAP[clean];
    return clean;
}

// Parse the product code out of a ProjectX contract ID.
// "CON.F.US.MNQ.M26" → "MNQ"
function productCodeFromContractId(contractId) {
    if (!contractId) return null;
    const parts = String(contractId).split('.');
    return parts.length >= 4 ? parts[3].toUpperCase() : null;
}

// Returns { tickSize, tickValue, pointValue, family, productCode } or null.
function getSpec(contractId) {
    const code = productCodeFromContractId(contractId);
    if (!code || !SPECS[code]) return null;
    const s = SPECS[code];
    return {
        tickSize:    s.tickSize,
        tickValue:   s.tickValue,
        pointValue:  s.tickValue / s.tickSize,
        family:      s.family,
        productCode: code,
    };
}

function pointsToDollars(points, contractId) {
    const spec = getSpec(contractId);
    if (!spec) return 0;
    return points * spec.pointValue;
}

function dollarsToPoints(dollars, contractId) {
    const spec = getSpec(contractId);
    if (!spec || spec.pointValue === 0) return 0;
    return dollars / spec.pointValue;
}

function roundToTick(price, contractId) {
    const spec = getSpec(contractId);
    if (!spec) return price;
    const ticks = Math.round(price / spec.tickSize);
    return Math.round(ticks * spec.tickSize * 1e8) / 1e8;
}

// List of known family codes — used for per-family open-position gating.
const FAMILIES = ['NQ', 'GC', 'ES'];

module.exports = {
    normalizeInstrument,
    productCodeFromContractId,
    getSpec,
    pointsToDollars,
    dollarsToPoints,
    roundToTick,
    FAMILIES,
};

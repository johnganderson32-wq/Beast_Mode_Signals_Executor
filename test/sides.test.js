'use strict';

// Regression test for the 2026-04-20 live-trading bug: bearish BEAST signal
// entered LONG because the direction→side ternary was inverted. TopstepX side
// convention is 0=Buy, 1=Sell. Guards against future re-inversion.

const assert = require('assert');
const { sidesForDirection } = require('../src/projectx');

function run() {
    let failed = 0;

    const bull = sidesForDirection('bullish');
    try {
        assert.deepStrictEqual(bull, { entrySide: 0, exitSide: 1 },
            `bullish should map to entrySide=0 (Buy) / exitSide=1 (Sell); got ${JSON.stringify(bull)}`);
        console.log('PASS  bullish → Buy entry, Sell exit');
    } catch (e) { console.error('FAIL ', e.message); failed++; }

    const bear = sidesForDirection('bearish');
    try {
        assert.deepStrictEqual(bear, { entrySide: 1, exitSide: 0 },
            `bearish should map to entrySide=1 (Sell) / exitSide=0 (Buy); got ${JSON.stringify(bear)}`);
        console.log('PASS  bearish → Sell entry, Buy exit');
    } catch (e) { console.error('FAIL ', e.message); failed++; }

    // Case-insensitive
    try {
        assert.deepStrictEqual(sidesForDirection('BULLISH'), { entrySide: 0, exitSide: 1 });
        assert.deepStrictEqual(sidesForDirection('Bearish'), { entrySide: 1, exitSide: 0 });
        console.log('PASS  case-insensitive direction');
    } catch (e) { console.error('FAIL  case-insensitive:', e.message); failed++; }

    // Anything not 'bullish' (including junk) is treated as bearish. This is
    // safe because validate() in webhook.js rejects invalid direction values
    // before placeOrder is ever called.
    try {
        assert.deepStrictEqual(sidesForDirection('anything-else'), { entrySide: 1, exitSide: 0 });
        console.log('PASS  non-bullish defaults to bearish sides (webhook gate handles validation)');
    } catch (e) { console.error('FAIL  non-bullish default:', e.message); failed++; }

    if (failed > 0) {
        console.error(`\n${failed} test(s) failed`);
        process.exit(1);
    }
    console.log('\nAll side-mapping regression tests passed');
}

run();

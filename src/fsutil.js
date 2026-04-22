'use strict';

// Atomic file write — write to a .tmp sibling, then rename over the target.
// rename is atomic on POSIX and on same-volume Windows. A crash between the
// writeFileSync and the renameSync leaves the previous target intact plus a
// stray .tmp file; the previous target is what gets read on next boot.
// Ported from EvilSignals-Executor verbatim 2026-04-22.

const fs = require('fs');

function atomicWrite(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

module.exports = { atomicWrite };

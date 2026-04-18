'use strict';

// SSE log streaming — captures console output and broadcasts to connected dashboard clients

const clients = [];
const buffer  = [];
const MAX_BUFFER = 500;

function addClient(res) {
    res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection:      'keep-alive',
    });
    res.write('\n');

    // Send buffered lines so the client catches up
    for (const line of buffer) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
    }

    clients.push(res);
    res.on('close', () => {
        const idx = clients.indexOf(res);
        if (idx !== -1) clients.splice(idx, 1);
    });
}

function broadcast(line) {
    const msg = `data: ${JSON.stringify(line)}\n\n`;
    for (let i = clients.length - 1; i >= 0; i--) {
        try { clients[i].write(msg); } catch { clients.splice(i, 1); }
    }
}

function addLine(text) {
    buffer.push(text);
    if (buffer.length > MAX_BUFFER) buffer.shift();
    broadcast(text);
}

// Monkey-patch console to capture all output
const origLog  = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origErr  = console.error.bind(console);

function formatArgs(args) {
    return args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}

console.log = function (...args) {
    origLog(...args);
    addLine(formatArgs(args));
};

console.warn = function (...args) {
    origWarn(...args);
    addLine('[WARN] ' + formatArgs(args));
};

console.error = function (...args) {
    origErr(...args);
    addLine('[ERR] ' + formatArgs(args));
};

module.exports = { addClient, addLine };

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createSyslogCollector } from '../src/collector/syslog-collector.js';

function validEvent(overrides = {}) {
    return {
        timestamp: '2026-11-05T13:45:00-03:00',
        site: 'www.example.com',
        ip: '203.0.113.10',
        method: 'GET',
        path: '/produto/1?utm=test',
        final_uri: '/index.php',
        status: 200,
        request_time: 0.05,
        upstream_addr: 'unix:/run/php/php8.2-fpm.sock',
        upstream_time: '0.040',
        dynamic: 1,
        scheme: 'https',
        body_bytes_sent: 100,
        user_agent: 'Mozilla/5.0',
        request_id: 'abc12345',
        server_name: 'www.example.com',
        ...overrides,
    };
}

function syslogMessage(event) {
    return `<134>Nov  5 13:45:00 web01 nodefw: ${JSON.stringify(event)}`;
}

function sendUdp(port, payload) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');

        socket.send(buffer, port, '127.0.0.1', (error) => {
            socket.close();
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

async function sendMany(port, payloads) {
    const socket = dgram.createSocket('udp4');

    await Promise.all(payloads.map((payload) => new Promise((resolve, reject) => {
        socket.send(Buffer.from(payload, 'utf8'), port, '127.0.0.1', (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    })));

    socket.close();
}

async function waitFor(predicate, label, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`${label} timed out`);
        }
        await delay(10);
    }
}

test('collector receives and validates a UDP event', async (t) => {
    const events = [];
    const invalid = [];
    const collector = createSyslogCollector({
        port: 0,
        logger: null,
        onEvent: (event) => events.push(event),
        onInvalid: (error) => invalid.push(error),
    });
    t.after(() => collector.stop());

    const address = await collector.start();
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
    assert.equal(collector.getStats().started, true);

    await sendUdp(address.port, syslogMessage(validEvent()));
    await waitFor(() => events.length === 1, 'valid event');

    const event = events[0];
    assert.equal(event.site, 'www.example.com');
    assert.equal(event.path, '/produto/1');
    assert.equal(event.dynamic, true);
    assert.equal(event.ipScope, 'documentation');
    assert.equal(event.syslog.hostname, 'web01');
    assert.equal(event.syslog.tag, 'nodefw');
    assert.equal(event.syslog.priority, 134);

    const stats = collector.getStats();
    assert.equal(stats.received, 1);
    assert.equal(stats.accepted, 1);
    assert.equal(stats.invalid, 0);
    assert.equal(stats.address.port, address.port);
    assert.equal(invalid.length, 0);

    await collector.stop();
    assert.equal(collector.getStats().started, false);
});

test('collector handles a burst of valid datagrams', async (t) => {
    const events = [];
    const collector = createSyslogCollector({
        port: 0,
        logger: null,
        onEvent: (event) => events.push(event),
    });
    t.after(() => collector.stop());

    const address = await collector.start();
    const payloads = Array.from({ length: 100 }, () => syslogMessage(validEvent()));
    await sendMany(address.port, payloads);
    await waitFor(() => events.length === 100, 'burst of 100 events', 5000);

    const stats = collector.getStats();
    assert.equal(stats.received, 100);
    assert.equal(stats.accepted, 100);
    assert.equal(stats.invalid, 0);
});

test('collector counts malformed, unexpected tag and oversize datagrams', async (t) => {
    const invalid = [];
    const collector = createSyslogCollector({
        port: 0,
        maxMessageBytes: 1024,
        logger: null,
        onInvalid: (error) => invalid.push(error),
    });
    t.after(() => collector.stop());

    const address = await collector.start();

    await sendUdp(address.port, '<134>Nov  5 13:45:00 other: {"a":1}');
    await waitFor(() => invalid.length === 1, 'unexpected tag');
    assert.equal(invalid[0].reason, 'unexpected_tag');

    await sendUdp(address.port, 'nodefw: not-json');
    await waitFor(() => invalid.length === 2, 'invalid json');
    assert.equal(invalid[1].reason, 'invalid_json');

    await sendUdp(address.port, Buffer.alloc(2048, 0x61));
    await waitFor(() => invalid.length === 3, 'oversize');
    assert.equal(invalid[2].reason, 'oversize');

    const stats = collector.getStats();
    assert.equal(stats.received, 3);
    assert.equal(stats.accepted, 0);
    assert.equal(stats.invalid, 3);
    assert.equal(stats.invalidByReason.unexpected_tag, 1);
    assert.equal(stats.invalidByReason.invalid_json, 1);
    assert.equal(stats.invalidByReason.oversize, 1);
});

test('collector start is idempotent and stop is safe', async () => {
    const collector = createSyslogCollector({ port: 0, logger: null });

    const first = await collector.start();
    const second = await collector.start();
    assert.equal(second.port, first.port);

    await collector.stop();
    await collector.stop();
    assert.equal(collector.getStats().started, false);
});

test('collector rejects a non-loopback host', () => {
    assert.throws(
        () => createSyslogCollector({ host: '0.0.0.0', port: 5514, logger: null }),
        /loopback/
    );
});

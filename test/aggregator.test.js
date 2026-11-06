import assert from 'node:assert/strict';
import test from 'node:test';

import { createEventAggregator } from '../src/storage/aggregator.js';
import { createEventQueue } from '../src/storage/event-queue.js';

function event(overrides = {}) {
    return {
        timestamp: '2026-11-05T17:00:10.000Z',
        receivedAt: '2026-11-05T17:00:10.000Z',
        requestId: 'abc12345',
        site: 'www.example.com',
        ip: '203.0.113.10',
        ipScope: 'documentation',
        method: 'GET',
        path: '/a',
        finalUri: '/index.php',
        status: 200,
        requestTime: 0.1,
        upstreamAddress: 'unix:/run/php/php8.2-fpm.sock',
        upstreamTime: '0.1',
        dynamic: true,
        scheme: 'https',
        bodyBytesSent: 10,
        userAgent: 'Mozilla/5.0',
        ...overrides,
    };
}

function createFakeRedis({ ready = true, exec = null } = {}) {
    const commands = [];

    const client = {
        isReady: ready,
        multi() {
            const multi = {
                addCommand(args) {
                    commands.push(args);
                    return multi;
                },
                async exec() {
                    if (exec) {
                        return exec(commands);
                    }
                    return commands.map(() => 1);
                },
            };
            return multi;
        },
    };

    return {
        client,
        commands,
        isReady: () => ready,
    };
}

function config(overrides = {}) {
    return {
        prefix: 'nodfw:test',
        flushIntervalMs: 100,
        batchSize: 200,
        writeTimeoutMs: 1000,
        eventStreamEnabled: false,
        eventStreamMaxlen: 1000,
        ...overrides,
    };
}

test('aggregator flushes queued events to Redis', async () => {
    const fake = createFakeRedis();
    const queue = createEventQueue({ maxSize: 10 });
    const aggregator = createEventAggregator({
        redis: fake,
        queue,
        config: config(),
    });

    queue.push(event());
    queue.push(event({ status: 404 }));
    const result = await aggregator.flushOnce();

    assert.equal(result.events, 2);
    assert.equal(result.written, 2);
    assert.equal(queue.size(), 0);

    const stats = aggregator.getStats();
    assert.equal(stats.batches, 1);
    assert.equal(stats.writtenEvents, 2);
    assert.equal(stats.writeFailures, 0);
    assert.equal(stats.queue.currentDepth, 0);

    assert.ok(fake.commands.some((args) => args[0] === 'INCRBY'));
    assert.ok(fake.commands.some((args) => args[0] === 'ZINCRBY'));
    assert.ok(fake.commands.some((args) => args[0] === 'HINCRBY'));
    assert.ok(fake.commands.some((args) => args[0] === 'PFADD'));
    assert.ok(fake.commands.some((args) => args[0] === 'HSETNX'));
});

test('aggregator discards a batch when Redis fails', async () => {
    const fake = createFakeRedis({
        exec: async () => {
            throw new Error('redis down');
        },
    });
    const queue = createEventQueue({ maxSize: 10 });
    const aggregator = createEventAggregator({
        redis: fake,
        queue,
        config: config(),
    });

    queue.push(event());
    const result = await aggregator.flushOnce();

    assert.equal(result.written, 0);
    assert.equal(queue.size(), 0);

    const stats = aggregator.getStats();
    assert.equal(stats.writeFailures, 1);
    assert.equal(stats.failedEvents, 1);
    assert.equal(stats.writtenEvents, 0);
    assert.match(stats.lastError.message, /redis down/);
});

test('aggregator opens the circuit when Redis is not ready and keeps the queue', async () => {
    const fake = createFakeRedis({ ready: false });
    const queue = createEventQueue({ maxSize: 10 });
    const aggregator = createEventAggregator({
        redis: fake,
        queue,
        config: config(),
    });

    queue.push(event());
    const result = await aggregator.flushOnce();

    assert.equal(result.written, 0);
    assert.equal(result.skipped, true);
    assert.equal(fake.commands.length, 0);
    assert.equal(queue.size(), 1);

    const stats = aggregator.getStats();
    assert.equal(stats.circuitOpen, true);
    assert.equal(stats.skippedFlushes, 1);
    assert.equal(stats.writeFailures, 0);
    assert.equal(stats.failedEvents, 0);
});

test('aggregator stop flushes one final batch', async () => {
    const fake = createFakeRedis();
    const queue = createEventQueue({ maxSize: 10 });
    const aggregator = createEventAggregator({
        redis: fake,
        queue,
        config: config(),
    });

    queue.push(event());
    await aggregator.stop();

    assert.equal(queue.size(), 0);
    assert.equal(aggregator.getStats().writtenEvents, 1);
});

test('aggregator returns an empty result for an empty queue', async () => {
    const fake = createFakeRedis();
    const aggregator = createEventAggregator({
        redis: fake,
        queue: createEventQueue({ maxSize: 10 }),
        config: config(),
    });

    const result = await aggregator.flushOnce();
    assert.deepEqual(result, { events: 0, written: 0 });
});

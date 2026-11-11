import assert from 'node:assert/strict';
import test from 'node:test';

import { StorageNotReadyError } from '../src/storage/errors.js';
import { createRedisQueries } from '../src/storage/queries.js';

const config = { prefix: 'nodfw:test' };

function compareIds(left, right) {
    const [leftMs, leftSeq] = left.split('-').map(Number);
    const [rightMs, rightSeq] = right.split('-').map(Number);
    return leftMs === rightMs ? leftSeq - rightSeq : leftMs - rightMs;
}

function streamEntry(id, fields) {
    return {
        id,
        message: new Map(Object.entries(fields)),
    };
}

function createFakeRedis(entries, { ready = true } = {}) {
    const calls = [];

    return {
        calls,
        assertReady() {
            if (!ready) {
                throw new StorageNotReadyError();
            }
        },
        client: {
            async xRevRange(key, end, start, options) {
                calls.push({ key, end, start, count: options?.COUNT });
                if (end === '+') {
                    return entries.slice(0, options?.COUNT ?? entries.length);
                }
                return entries
                    .filter((entry) => compareIds(entry.id, end) <= 0)
                    .slice(0, options?.COUNT ?? entries.length);
            },
        },
    };
}

function baseFields(overrides = {}) {
    return {
        timestamp: '2026-11-06T12:00:00-03:00',
        receivedAt: '2026-11-06T15:00:00.000Z',
        site: 'casadoppia.site',
        ip: '203.0.113.10',
        method: 'GET',
        path: '/catalogsearch/result/',
        finalUri: '/index.php',
        status: '200',
        requestTime: '0.042',
        dynamic: '1',
        userAgent: 'Mozilla/5.0',
        country: 'BR',
        asn: '12345',
        asnOrg: 'Provedor Exemplo',
        score: '60',
        level: 'suspect',
        reasons: JSON.stringify(['rate_1m:3/1']),
        mode: '1',
        blockEligible: '0',
        excluded: '0',
        ...overrides,
    };
}

test('recent events are newest first and use a stable cursor', async () => {
    const entries = [
        streamEntry('3000-0', baseFields({ path: '/three' })),
        streamEntry('2000-0', baseFields({ path: '/two' })),
        streamEntry('1000-0', baseFields({ path: '/one' })),
    ];
    const redis = createFakeRedis(entries);
    const queries = createRedisQueries({ redis, config });

    const first = await queries.getRecentEvents({ limit: 2 });
    assert.deepEqual(first.events.map((event) => event.path), ['/three', '/two']);
    assert.equal(first.page.hasMore, true);
    assert.equal(first.page.nextCursor, '2000-0');
    assert.equal(first.page.count, 2);
    assert.equal(redis.calls[0].key, 'nodfw:test:events');

    const second = await queries.getRecentEvents({ limit: 2, cursor: first.page.nextCursor });
    assert.deepEqual(second.events.map((event) => event.path), ['/one']);
    assert.equal(second.page.hasMore, false);
    assert.equal(second.page.nextCursor, null);
});

test('recent events filters by site, IP and status', async () => {
    const entries = [
        streamEntry('3000-0', baseFields({ site: 'outro.site', path: '/other' })),
        streamEntry('2000-0', baseFields({ ip: '198.51.100.20', path: '/ip-other' })),
        streamEntry('1000-0', baseFields({ status: '404', path: '/not-found' })),
        streamEntry('900-0', baseFields({ path: '/match' })),
    ];
    const redis = createFakeRedis(entries);
    const queries = createRedisQueries({ redis, config });

    const result = await queries.getRecentEvents({
        site: 'CASADOPPIA.site',
        ip: '203.0.113.10',
        status: '200',
        limit: 50,
    });

    assert.deepEqual(result.events.map((event) => event.path), ['/match']);
    assert.equal(result.events[0].site, 'casadoppia.site');
});

test('recent events strip query strings and truncate User-Agent', async () => {
    const longUserAgent = 'A'.repeat(220);
    const entries = [
        streamEntry('1000-0', baseFields({
            path: '/foo?token=secret',
            finalUri: '/index.php?token=secret',
            userAgent: longUserAgent,
        })),
    ];
    const queries = createRedisQueries({
        redis: createFakeRedis(entries),
        config,
    });

    const result = await queries.getRecentEvents({ limit: 1 });
    const event = result.events[0];

    assert.equal(event.path, '/foo');
    assert.equal(event.finalUri, '/index.php');
    assert.equal(event.userAgent.length, 160);
    assert.equal(event.userAgentTruncated, true);
    assert.equal(event.status, 200);
    assert.equal(event.requestTime, 0.042);
    assert.equal(event.dynamic, true);
    assert.equal(event.country, 'BR');
    assert.equal(event.asn, 12345);
    assert.equal(event.asnOrg, 'Provedor Exemplo');
    assert.equal(event.score, 60);
    assert.equal(event.level, 'suspect');
    assert.deepEqual(event.reasons, ['rate_1m:3/1']);
    assert.equal(event.mode, 1);
    assert.equal(event.blockEligible, false);
    assert.equal(event.excluded, false);
});

test('recent events validate filters, cursor and page size', async () => {
    const queries = createRedisQueries({
        redis: createFakeRedis([]),
        config,
    });

    for (const options of [
        { site: 'bad site' },
        { ip: '999.1.1.1' },
        { status: '99' },
        { status: 'abc' },
        { limit: 101 },
        { limit: ['10', '20'] },
        { cursor: 'not-a-stream-id' },
    ]) {
        await assert.rejects(
            () => queries.getRecentEvents(options),
            (error) => error.code === 'INVALID_QUERY'
        );
    }
});

test('recent events handle an empty stream and unavailable Redis', async () => {
    const queries = createRedisQueries({
        redis: createFakeRedis([]),
        config,
    });

    const empty = await queries.getRecentEvents({ limit: 25 });
    assert.deepEqual(empty.events, []);
    assert.equal(empty.page.hasMore, false);
    assert.equal(empty.page.nextCursor, null);

    const unavailable = createRedisQueries({
        redis: createFakeRedis([], { ready: false }),
        config,
    });
    await assert.rejects(
        () => unavailable.getRecentEvents({ limit: 25 }),
        (error) => error.code === 'STORAGE_NOT_READY'
    );
});

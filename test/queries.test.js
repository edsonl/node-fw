import assert from 'node:assert/strict';
import test from 'node:test';

import { StorageNotReadyError } from '../src/storage/errors.js';
import { createRedisQueries } from '../src/storage/queries.js';

function createFakeRedis({ ready = true } = {}) {
    const commands = [];

    return {
        commands,
        assertReady() {
            if (!ready) {
                throw new StorageNotReadyError();
            }
        },
        client: {
            multi() {
                const replies = [];
                const multi = {
                    get(key) {
                        commands.push(['get', key]);
                        replies.push('2');
                        return multi;
                    },
                    pfCount(key) {
                        commands.push(['pfCount', key]);
                        replies.push(5);
                        return multi;
                    },
                    hGetAll(key) {
                        commands.push(['hGetAll', key]);
                        replies.push({ 200: '3' });
                        return multi;
                    },
                    zRangeWithScores(key, min, max) {
                        commands.push(['zRangeWithScores', key, min, max]);
                        replies.push(key.includes('country')
                            ? [{ value: 'BR', score: 4 }]
                            : [{ value: '203.0.113.10', score: 2 }]);
                        return multi;
                    },
                    async exec() {
                        return replies;
                    },
                };
                return multi;
            },
        },
    };
}

const config = { prefix: 'nodfw:test' };
const now = new Date('2026-11-05T17:00:20.000Z');

test('summary returns global aggregated windows and rankings', async () => {
    const redis = createFakeRedis();
    const queries = createRedisQueries({ redis, config });

    const summary = await queries.getSummary({ now });

    assert.equal(summary.timestamp, now.toISOString());
    assert.equal(summary.site, null);
    assert.equal(summary.global.requests['1s'], 2);
    assert.equal(summary.global.requests['1m'], 2);
    assert.equal(summary.global.dynamic['1m'], 2);
    assert.equal(summary.global.unique['1m'], 5);
    assert.equal(summary.global.status['200'], 3);
    assert.deepEqual(summary.global.topCountries, [{ country: 'BR', count: 4 }]);
    assert.deepEqual(summary.global.topIps, [{ ip: '203.0.113.10', count: 2 }]);
    assert.ok(redis.commands.some(([command]) => command === 'pfCount'));
});

test('summary includes site section and normalizes the site name', async () => {
    const redis = createFakeRedis();
    const queries = createRedisQueries({ redis, config });

    const summary = await queries.getSummary({ site: 'WWW.Example.com.', now });

    assert.equal(summary.site.name, 'www.example.com');
    assert.equal(summary.site.requests['5m'], 2);
    assert.equal(summary.site.unique['15m'], 5);
    assert.deepEqual(summary.site.topIps, [{ ip: '203.0.113.10', count: 2 }]);
});

test('summary rejects invalid sites and unavailable storage', async () => {
    const queries = createRedisQueries({ redis: createFakeRedis(), config });
    await assert.rejects(
        () => queries.getSummary({ site: 'bad site', now }),
        (error) => error.code === 'INVALID_QUERY'
    );

    const unavailable = createRedisQueries({
        redis: createFakeRedis({ ready: false }),
        config,
    });
    await assert.rejects(
        () => unavailable.getSummary({ now }),
        (error) => error.code === 'STORAGE_NOT_READY'
    );
});

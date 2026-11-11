import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';

const config = loadConfig({ LOG_LEVEL: 'silent' });

test('health, readiness and stats routes reflect collector and Redis state', async (t) => {
    let collectorStats = {
        started: true,
        address: { address: '127.0.0.1', family: 'IPv4', port: 5514 },
    };
    const redisStats = { ready: true, database: 7 };
    const pipelineStats = { batches: 2, writtenEvents: 40 };
    const maxmindStats = {
        enabled: true,
        countryReady: true,
        asnReady: false,
        degraded: true,
        cacheEntries: 1,
        cacheMaxEntries: 10,
    };
    const classificationStats = {
        decisions: 4,
        levelCounts: { normal: 3, observation: 0, suspect: 1, critical: 0 },
        modeCounts: { 1: 4, 2: 0, 3: 0 },
        trackedIps: 2,
        hardExceptions: 0,
        errors: 0,
        rulesSource: 'default',
    };

    const app = buildApp({
        config,
        logger: false,
        getCollectorStats: () => collectorStats,
        getPipelineStats: () => pipelineStats,
        getRedisStats: () => redisStats,
        getMaxMindStats: () => maxmindStats,
        getClassificationStats: () => classificationStats,
    });
    t.after(() => app.close());

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers['cache-control'], 'no-store');
    assert.equal(health.json().status, 'ok');
    assert.equal(health.json().service, 'node-fw');
    assert.equal(health.json().version, '0.7.0');
    assert.equal(health.json().collector.started, true);
    assert.equal(health.json().redis.ready, true);
    assert.equal(health.json().maxmind.degraded, true);
    assert.equal(health.json().classification.decisions, 4);

    const ready = await app.inject({ method: 'GET', url: '/api/ready' });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().status, 'ready');
    assert.equal(ready.json().checks.collector, 'ok');
    assert.equal(ready.json().checks.redis, 'ok');
    assert.equal(ready.json().checks.maxmind, 'degraded');
    assert.equal(ready.json().checks.classification, 'ok');

    const stats = await app.inject({ method: 'GET', url: '/api/stats' });
    assert.equal(stats.statusCode, 200);
    assert.equal(stats.json().status, 'ok');
    assert.equal(stats.json().collector.address.port, 5514);
    assert.equal(stats.json().pipeline.batches, 2);
    assert.equal(stats.json().redis.database, 7);
    assert.equal(stats.json().maxmind.countryReady, true);
    assert.equal(stats.json().classification.decisions, 4);
    assert.equal(stats.json().classification.levelCounts.suspect, 1);

    redisStats.ready = false;
    const redisDown = await app.inject({ method: 'GET', url: '/api/ready' });
    assert.equal(redisDown.statusCode, 503);
    assert.equal(redisDown.json().status, 'not_ready');
    assert.equal(redisDown.json().checks.redis, 'down');

    redisStats.ready = true;
    collectorStats = { started: false, address: null };
    const collectorDown = await app.inject({ method: 'GET', url: '/api/ready' });
    assert.equal(collectorDown.statusCode, 503);
    assert.equal(collectorDown.json().checks.collector, 'down');
});

test('stats returns 503 when the collector is unavailable', async (t) => {
    const app = buildApp({
        config,
        logger: false,
        getCollectorStats: () => null,
        getRedisStats: () => ({ ready: true, database: 7 }),
    });
    t.after(() => app.close());

    const response = await app.inject({ method: 'GET', url: '/api/stats' });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().status, 'not_ready');
});

test('summary route returns data and maps query errors', async (t) => {
    const app = buildApp({
        config,
        logger: false,
        getSummary: async ({ site }) => {
            if (site === 'bad') {
                const error = new Error('bad site');
                error.code = 'INVALID_QUERY';
                throw error;
            }
            if (site === 'down') {
                const error = new Error('storage down');
                error.code = 'STORAGE_NOT_READY';
                throw error;
            }
            return {
                site: site ? { name: site } : null,
                global: { requests: { '1m': 10 } },
            };
        },
    });
    t.after(() => app.close());

    const ok = await app.inject({ method: 'GET', url: '/api/summary?site=www.example.com' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().status, 'ok');
    assert.equal(ok.json().site.name, 'www.example.com');

    const invalid = await app.inject({ method: 'GET', url: '/api/summary?site=bad' });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error, 'invalid_query');

    const unavailable = await app.inject({ method: 'GET', url: '/api/summary?site=down' });
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.json().error, 'storage_not_ready');
});

test('summary returns 503 when not configured', async (t) => {
    const app = buildApp({ config, logger: false });
    t.after(() => app.close());

    const response = await app.inject({ method: 'GET', url: '/api/summary' });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'summary_unavailable');
});

test('unknown routes return a JSON 404', async (t) => {
    const app = buildApp({ config, logger: false });
    t.after(() => app.close());

    const response = await app.inject({ method: 'GET', url: '/unknown' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: 'not_found' });
});

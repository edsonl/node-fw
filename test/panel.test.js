import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';

const config = loadConfig({ LOG_LEVEL: 'silent' });

test('panel serves HTML, CSS and JS with restrictive headers', async (t) => {
    const app = buildApp({ config, logger: false });
    t.after(() => app.close());

    const html = await app.inject({ method: 'GET', url: '/panel' });
    assert.equal(html.statusCode, 200);
    assert.match(html.headers['content-type'], /text\/html/);
    assert.equal(html.headers['cache-control'], 'no-store');
    assert.match(html.headers['content-security-policy'], /default-src 'self'/);
    assert.match(html.body, /Observação/);
    assert.match(html.body, /MaxMind/);
    assert.match(html.body, /GeoLite2/);
    assert.match(html.body, /Classificação/);
    assert.match(html.body, /Score/);

    const css = await app.inject({ method: 'GET', url: '/panel/style.css' });
    assert.equal(css.statusCode, 200);
    assert.match(css.headers['content-type'], /text\/css/);

    const js = await app.inject({ method: 'GET', url: '/panel/app.js' });
    assert.equal(js.statusCode, 200);
    assert.match(js.headers['content-type'], /javascript/);

    const redirect = await app.inject({ method: 'GET', url: '/' });
    assert.equal(redirect.statusCode, 302);
    assert.equal(redirect.headers.location, '/panel');
});

test('recent events endpoint validates and returns data', async (t) => {
    const calls = [];
    const app = buildApp({
        config,
        logger: false,
        getRecentEvents: async (query) => {
            calls.push(query);
            return {
                timestamp: '2026-11-06T15:00:00.000Z',
                events: [{
                    id: '1-0',
                    site: 'casadoppia.site',
                    path: '/',
                    status: 200,
                    dynamic: true,
                    country: 'BR',
                    asn: 12345,
                    asnOrg: 'Provedor Exemplo',
                    score: 60,
                    level: 'suspect',
                    reasons: ['rate_1m:3/1'],
                    mode: 1,
                    blockEligible: false,
                }],
                page: {
                    limit: 10,
                    count: 1,
                    hasMore: false,
                    nextCursor: null,
                    scanned: 1,
                },
            };
        },
    });
    t.after(() => app.close());

    const response = await app.inject({
        method: 'GET',
        url: '/api/events/recent?site=casadoppia.site&limit=10',
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.json().status, 'ok');
    assert.equal(response.json().events[0].path, '/');
    assert.equal(response.json().events[0].country, 'BR');
    assert.equal(response.json().events[0].asn, 12345);
    assert.equal(response.json().events[0].score, 60);
    assert.equal(response.json().events[0].level, 'suspect');
    assert.equal(calls[0].site, 'casadoppia.site');
    assert.equal(calls[0].limit, '10');
});

test('recent events maps invalid query and storage errors', async (t) => {
    const app = buildApp({
        config,
        logger: false,
        getRecentEvents: async () => {
            const error = new Error('bad');
            error.code = 'INVALID_QUERY';
            throw error;
        },
    });
    t.after(() => app.close());

    const invalid = await app.inject({ method: 'GET', url: '/api/events/recent?limit=101' });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error, 'invalid_query');

    const unavailable = buildApp({
        config,
        logger: false,
        getRecentEvents: async () => {
            const error = new Error('storage');
            error.code = 'STORAGE_NOT_READY';
            throw error;
        },
    });
    t.after(() => unavailable.close());

    const down = await unavailable.inject({ method: 'GET', url: '/api/events/recent' });
    assert.equal(down.statusCode, 503);
    assert.equal(down.json().error, 'storage_not_ready');
});

test('recent events returns 503 when not configured', async (t) => {
    const app = buildApp({ config, logger: false });
    t.after(() => app.close());

    const response = await app.inject({ method: 'GET', url: '/api/events/recent' });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'events_unavailable');
});

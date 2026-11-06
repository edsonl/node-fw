import assert from 'node:assert/strict';
import test from 'node:test';

import { bucketFor, buildAggregationPlan, ttlForWindow } from '../src/storage/aggregation-plan.js';

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
        dynamic: false,
        scheme: 'https',
        bodyBytesSent: 10,
        userAgent: 'Mozilla/5.0',
        country: 'br',
        ...overrides,
    };
}

function findCounter(plan, fragment) {
    return plan.counters.find((entry) => entry.key.includes(fragment));
}

function findZset(plan, fragment, member) {
    return plan.zsets.find((entry) => entry.key.includes(fragment) && entry.member === member);
}

function findHash(plan, fragment, field) {
    return plan.hashes.find((entry) => entry.key.includes(fragment) && entry.field === field);
}

test('builds counters, windows, rankings, reputation and stream entries', () => {
    const first = event();
    const second = event({
        receivedAt: '2026-11-05T17:00:20.000Z',
        status: 404,
        path: '/b',
        dynamic: true,
    });

    const plan = buildAggregationPlan([first, second], {
        prefix: 'nodfw:test',
        eventStreamEnabled: true,
        eventStreamMaxlen: 1000,
    });

    const oneSecondCounters = plan.counters.filter((entry) => entry.key.includes('rate:g:1s:'));
    assert.equal(oneSecondCounters.length, 2);
    assert.deepEqual(oneSecondCounters.map((entry) => entry.amount), [1, 1]);
    assert.equal(findCounter(plan, 'rate:g:1m:').amount, 2);
    assert.equal(findCounter(plan, 'rate:site:www.example.com:1m:').amount, 2);
    assert.equal(findCounter(plan, 'rate:ip:203.0.113.10:1m:').amount, 2);
    assert.equal(findCounter(plan, 'rate:ip_site:203.0.113.10:www.example.com:1m:').amount, 2);
    assert.equal(findCounter(plan, 'dynamic:g:1m:').amount, 1);
    assert.equal(oneSecondCounters[0].ttl, ttlForWindow(1));
    assert.equal(findCounter(plan, 'rate:g:1m:').ttl, ttlForWindow(60));
    assert.equal(findCounter(plan, 'rate:ip:203.0.113.10:1s:'), undefined);

    assert.equal(findZset(plan, 'country:g:1m:', 'BR').amount, 2);
    assert.equal(findZset(plan, 'rank:ip:g:1m:', '203.0.113.10').amount, 2);
    assert.equal(findZset(plan, 'rank:ip:site:www.example.com:1m:', '203.0.113.10').amount, 2);

    assert.equal(findHash(plan, 'status:g:1m:', '200').amount, 1);
    assert.equal(findHash(plan, 'status:g:1m:', '404').amount, 1);

    const unique = plan.hlls.find((entry) => entry.key.includes('uniq:g:1m:'));
    assert.deepEqual(unique.members, ['203.0.113.10']);

    const ipSites = plan.sets.find((entry) => entry.key.includes('ip:203.0.113.10:sites'));
    assert.deepEqual(ipSites.members, ['www.example.com']);
    assert.equal(ipSites.ttl, 86400);

    const reputation = plan.reputations.find((entry) => entry.ip === '203.0.113.10');
    assert.equal(reputation.count, 2);
    assert.equal(reputation.firstSeen, '2026-11-05T17:00:10.000Z');
    assert.equal(reputation.lastSeen, '2026-11-05T17:00:20.000Z');
    assert.equal(reputation.lastStatus, 404);
    assert.equal(reputation.lastCountry, 'BR');
    assert.equal(reputation.ttl, 2592000);

    assert.equal(plan.streams.length, 2);
    const fields = plan.streams[1].fields;
    assert.equal(fields[fields.indexOf('path') + 1], '/b');
    assert.equal(fields[fields.indexOf('status') + 1], '404');
    assert.equal(fields[fields.indexOf('dynamic') + 1], '1');
    assert.equal(plan.stats.events, 2);
});

test('can disable the event stream and validates the prefix', () => {
    const plan = buildAggregationPlan([event()], {
        prefix: 'nodfw:test',
        eventStreamEnabled: false,
    });

    assert.deepEqual(plan.streams, []);
    assert.throws(
        () => buildAggregationPlan([event()], { prefix: 'bad prefix' }),
        /prefix/
    );
});

test('bucket and TTL helpers use deterministic windows', () => {
    const date = new Date('2026-11-05T17:00:20.000Z');

    assert.equal(bucketFor(date, 60), Date.parse('2026-11-05T17:00:00.000Z') / 1000);
    assert.equal(bucketFor(date, 300), Date.parse('2026-11-05T17:00:00.000Z') / 1000);
    assert.equal(ttlForWindow(1), 60);
    assert.equal(ttlForWindow(900), 1800);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createIpTracker } from '../src/classification/ip-tracker.js';

const base = Date.parse('2026-11-10T12:00:00.000Z');

test('tracks 1m/5m/15m windows, sites, status and burst', () => {
    const tracker = createIpTracker({ maxTrackedIps: 10, now: () => base });

    tracker.record({ ip: '8.8.8.8', site: 'a.example', status: 200, at: base + 1000 });
    tracker.record({ ip: '8.8.8.8', site: 'b.example', status: 404, at: base + 2000 });
    tracker.record({ ip: '8.8.8.8', site: 'a.example', status: 200, at: base + 61_000 });
    tracker.record({ ip: '8.8.8.8', site: 'a.example', status: 404, at: base + 4 * 60_000 });

    const stats = tracker.getStats('8.8.8.8', 'a.example', base + 4 * 60_000 + 1000);
    assert.equal(stats.count1m, 1);
    assert.equal(stats.count5m, 4);
    assert.equal(stats.count15m, 4);
    assert.equal(stats.site1m, 1);
    assert.equal(stats.site5m, 3);
    assert.equal(stats.burst, 1);
    assert.equal(stats.status5m['404'], 2);
    assert.equal(stats.total5m, 4);
    assert.equal(stats.distinctSites, 2);
});

test('prunes old buckets and caps burst storage', () => {
    const tracker = createIpTracker({ maxTrackedIps: 10, now: () => base });
    tracker.record({ ip: '8.8.8.8', site: 'a.example', status: 200, at: base + 1000 });

    const stats = tracker.getStats('8.8.8.8', 'a.example', base + 16 * 60_000);
    assert.equal(stats.count1m, 0);
    assert.equal(stats.count5m, 0);
    assert.equal(stats.count15m, 0);
});

test('evicts the oldest IP when the limit is reached', () => {
    const tracker = createIpTracker({ maxTrackedIps: 2, now: () => base });
    tracker.record({ ip: '1.1.1.1', site: 'a.example', status: 200, at: base + 1000 });
    tracker.record({ ip: '8.8.8.8', site: 'a.example', status: 200, at: base + 2000 });
    tracker.record({ ip: '9.9.9.9', site: 'a.example', status: 200, at: base + 3000 });

    assert.equal(tracker.size(), 2);
    assert.equal(tracker.getStats('1.1.1.1', 'a.example', base + 4000).count1m, 0);
    assert.equal(tracker.getStats('9.9.9.9', 'a.example', base + 4000).count1m, 1);
});

test('decays the previous score over inactive time', () => {
    const tracker = createIpTracker({ maxTrackedIps: 10, decayPerMinute: 5, now: () => base });
    tracker.record({ ip: '8.8.8.8', site: 'a.example', status: 200, at: base });
    tracker.finish('8.8.8.8', { score: 80, level: 'critical', at: base });

    assert.equal(tracker.getStats('8.8.8.8', 'a.example', base + 60_000).previousScore, 75);
    assert.equal(tracker.getStats('8.8.8.8', 'a.example', base + 5 * 60_000).previousScore, 55);
});

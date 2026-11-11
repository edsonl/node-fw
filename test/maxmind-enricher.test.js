import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createMaxMindEnricher } from '../src/enrichment/maxmind.js';

function maxmindConfig(overrides = {}) {
    return {
        enabled: true,
        dbDir: '/tmp/nodefw-maxmind-test',
        accountId: '',
        licenseKey: '',
        refreshMaxAgeDays: 3,
        downloadTimeoutMs: 1000,
        downloadRetries: 1,
        retryBackoffMs: 0,
        cacheMaxEntries: 100,
        cacheTtlMs: 60_000,
        lockStaleMs: 60_000,
        ...overrides,
    };
}

function fakeReader({ countryByIp = {}, asnByIp = {}, calls = null } = {}) {
    return {
        get(ip) {
            if (calls) {
                calls.push(ip);
            }
            if (Object.hasOwn(countryByIp, ip)) {
                return countryByIp[ip];
            }
            if (Object.hasOwn(asnByIp, ip)) {
                return asnByIp[ip];
            }
            return null;
        },
    };
}

function createOpenDatabase({ countryData, asnData, countryError = false, asnError = false } = {}) {
    const calls = [];
    const openDatabase = async (filePath) => {
        calls.push(filePath);
        if (filePath.endsWith('GeoLite2-Country.mmdb')) {
            if (countryError) {
                throw Object.assign(new Error('country unavailable'), { code: 'ENOENT' });
            }
            return fakeReader({ countryByIp: countryData, calls });
        }
        if (filePath.endsWith('GeoLite2-ASN.mmdb')) {
            if (asnError) {
                throw Object.assign(new Error('asn unavailable'), { code: 'ENOENT' });
            }
            return fakeReader({ asnByIp: asnData, calls });
        }
        throw new Error('unexpected path');
    };

    return { openDatabase, calls };
}

function event(ip) {
    return {
        ip,
        site: 'www.example.com',
        status: 200,
    };
}

test('enriches public IPv4 and IPv6 events', async () => {
    const { openDatabase } = createOpenDatabase({
        countryData: {
            '8.8.8.8': { country: { iso_code: 'US' } },
            '2001:4860:4860::8888': { registered_country: { iso_code: 'BR' } },
        },
        asnData: {
            '8.8.8.8': {
                autonomous_system_number: 15169,
                autonomous_system_organization: 'Google LLC',
            },
            '2001:4860:4860::8888': {
                autonomous_system_number: 15169,
                autonomous_system_organization: 'Google LLC',
            },
        },
    });
    const enricher = createMaxMindEnricher({
        config: maxmindConfig(),
        openDatabase,
    });

    await enricher.start();

    const ipv4 = enricher.enrich(event('8.8.8.8'));
    assert.equal(ipv4.country, 'US');
    assert.equal(ipv4.asn, 15169);
    assert.equal(ipv4.asnOrg, 'Google LLC');

    const ipv6 = enricher.enrich(event('2001:4860:4860::8888'));
    assert.equal(ipv6.country, 'BR');
    assert.equal(ipv6.asn, 15169);

    const stats = enricher.getStats();
    assert.equal(stats.countryReady, true);
    assert.equal(stats.asnReady, true);
    assert.equal(stats.ready, true);
    assert.equal(stats.degraded, false);
});

test('returns nulls for private, reserved and invalid IPs without lookups', async () => {
    const lookups = [];
    const enricher = createMaxMindEnricher({
        config: maxmindConfig(),
        openDatabase: async (filePath) => fakeReader({
            countryByIp: { '8.8.8.8': { country: { iso_code: 'US' } } },
            asnByIp: { '8.8.8.8': { autonomous_system_number: 15169 } },
            calls: lookups,
        }),
    });

    await enricher.start();
    lookups.length = 0;

    for (const ip of ['10.0.0.1', '192.168.1.1', '203.0.113.10', 'not-an-ip']) {
        const eventValue = enricher.enrich(event(ip));
        assert.equal(eventValue.country, null);
        assert.equal(eventValue.asn, null);
        assert.equal(eventValue.asnOrg, null);
    }

    assert.equal(lookups.length, 0);
    const stats = enricher.getStats();
    assert.ok(stats.privateSkips >= 2);
    assert.equal(stats.invalidSkips, 1);
});

test('caches public lookups within the TTL', async () => {
    let clock = 1000;
    const lookups = [];
    const enricher = createMaxMindEnricher({
        config: maxmindConfig({ cacheTtlMs: 5000, cacheMaxEntries: 10 }),
        now: () => clock,
        openDatabase: async () => fakeReader({
            countryByIp: { '8.8.8.8': { country: { iso_code: 'US' } } },
            asnByIp: { '8.8.8.8': { autonomous_system_number: 15169 } },
            calls: lookups,
        }),
    });

    await enricher.start();
    lookups.length = 0;

    enricher.enrich(event('8.8.8.8'));
    enricher.enrich(event('8.8.8.8'));
    assert.equal(lookups.length, 2);

    let stats = enricher.getStats();
    assert.equal(stats.cacheHits, 1);
    assert.equal(stats.cacheEntries, 1);

    clock += 5000;
    enricher.enrich(event('8.8.8.8'));
    assert.equal(lookups.length, 4);

    stats = enricher.getStats();
    assert.equal(stats.cacheMisses, 2);
});

test('limits the cache size', async () => {
    const enricher = createMaxMindEnricher({
        config: maxmindConfig({ cacheMaxEntries: 2, cacheTtlMs: 60_000 }),
        openDatabase: async () => fakeReader({
            countryByIp: {
                '8.8.8.8': { country: { iso_code: 'US' } },
                '1.1.1.1': { country: { iso_code: 'AU' } },
                '9.9.9.9': { country: { iso_code: 'CH' } },
            },
        }),
    });

    await enricher.start();
    enricher.enrich(event('8.8.8.8'));
    enricher.enrich(event('1.1.1.1'));
    enricher.enrich(event('9.9.9.9'));

    assert.equal(enricher.getStats().cacheEntries, 2);
});

test('starts degraded when one or both databases are missing or corrupt', async () => {
    const partial = createMaxMindEnricher({
        config: maxmindConfig(),
        openDatabase: createOpenDatabase({
            countryError: true,
            countryData: {},
            asnData: {
                '8.8.8.8': {
                    autonomous_system_number: 15169,
                    autonomous_system_organization: 'Google LLC',
                },
            },
        }).openDatabase,
    });

    await partial.start();
    const partialEvent = partial.enrich(event('8.8.8.8'));
    assert.equal(partialEvent.country, null);
    assert.equal(partialEvent.asn, 15169);
    assert.equal(partial.getStats().countryReady, false);
    assert.equal(partial.getStats().asnReady, true);
    assert.equal(partial.getStats().degraded, true);
    assert.equal(partial.getStats().lastError.code, 'ENOENT');

    const broken = createMaxMindEnricher({
        config: maxmindConfig(),
        openDatabase: async () => {
            throw new Error('corrupt database');
        },
    });

    await broken.start();
    const brokenEvent = broken.enrich(event('8.8.8.8'));
    assert.equal(brokenEvent.country, null);
    assert.equal(brokenEvent.asn, null);
    assert.equal(broken.getStats().ready, false);
});

test('disabled enrichment does not open files or invent data', async () => {
    let opened = 0;
    const enricher = createMaxMindEnricher({
        config: maxmindConfig({ enabled: false }),
        openDatabase: async () => {
            opened += 1;
            return fakeReader();
        },
    });

    await enricher.start();
    const value = enricher.enrich(event('8.8.8.8'));

    assert.equal(opened, 0);
    assert.equal(value.country, null);
    assert.equal(value.asn, null);
    assert.equal(enricher.getStats().enabled, false);
    assert.equal(enricher.getStats().ready, false);
});

test('reload replaces readers and keeps old data on failure', async () => {
    let countryCode = 'US';
    let failCountry = false;
    const enricher = createMaxMindEnricher({
        config: maxmindConfig(),
        openDatabase: async (filePath) => {
            if (filePath.endsWith('GeoLite2-Country.mmdb')) {
                if (failCountry) {
                    throw new Error('new country database invalid');
                }
                return fakeReader({
                    countryByIp: { '8.8.8.8': { country: { iso_code: countryCode } } },
                });
            }
            return fakeReader({
                asnByIp: { '8.8.8.8': { autonomous_system_number: 15169 } },
            });
        },
    });

    await enricher.start();
    assert.equal(enricher.enrich(event('8.8.8.8')).country, 'US');

    countryCode = 'BR';
    await enricher.reload();
    assert.equal(enricher.enrich(event('8.8.8.8')).country, 'BR');

    failCountry = true;
    await enricher.reload();
    assert.equal(enricher.enrich(event('8.8.8.8')).country, 'BR');
});

test('real reader treats corrupt MMDB files as unavailable', async (t) => {
    const dbDir = await mkdtemp(join(tmpdir(), 'nodefw-maxmind-corrupt-'));
    t.after(() => rm(dbDir, { recursive: true, force: true }));

    await writeFile(join(dbDir, 'GeoLite2-Country.mmdb'), 'not an mmdb');
    await writeFile(join(dbDir, 'GeoLite2-ASN.mmdb'), 'not an mmdb');

    const enricher = createMaxMindEnricher({
        config: maxmindConfig({ dbDir }),
    });

    await enricher.start();
    const value = enricher.enrich(event('8.8.8.8'));

    assert.equal(value.country, null);
    assert.equal(value.asn, null);
    assert.equal(enricher.getStats().countryReady, false);
    assert.equal(enricher.getStats().asnReady, false);
    assert.equal(enricher.getStats().degraded, true);
});

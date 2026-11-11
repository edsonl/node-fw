import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    DEFAULT_RULES,
    loadClassificationRules,
    mergeRuleSet,
    normalizeRuleSet,
} from '../src/classification/rules.js';

test('loads default rules when the config file is missing', async () => {
    const result = await loadClassificationRules({
        configPath: join(tmpdir(), 'does-not-exist-classification.json'),
    });

    assert.equal(result.source, 'default');
    assert.equal(result.rules.mode, 1);
    assert.equal(result.rules.thresholds.critical, 75);
    assert.equal(result.rules.sites['casadoppia.site'], undefined);
    assert.equal(result.rules.geoProfiles.enabled, true);
    assert.equal(result.rules.geoProfiles.profiles.relaxed.rateFactor, 1.5);
    assert.equal(result.rules.geoProfiles.profiles.standard.rateFactor, 1);
    assert.equal(result.rules.geoProfiles.profiles.strict.rateFactor, 0.5);
    assert.ok(result.rules.geoProfiles.countries.relaxed.includes('BR'));
    assert.ok(result.rules.geoProfiles.countries.strict.includes('SG'));
});

test('loads file rules and site overrides', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'nodefw-rules-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const configPath = join(dir, 'classification.json');
    await writeFile(configPath, JSON.stringify({
        mode: 2,
        thresholds: { suspect: 40 },
        criticalPaths: ['/custom-critical'],
        geoProfiles: {
            unknownProfile: 'strict',
            profiles: { strict: { rateFactor: 0.4 } },
            countries: { relaxed: ['br', 'us', 'fr'] },
        },
        sites: {
            'WWW.Example.com': {
                mode: 3,
                rateLimits: { perMinute: 60 },
                criticalPaths: ['/site-critical'],
                exceptions: { ips: ['8.8.8.8'] },
            },
        },
    }));

    const result = await loadClassificationRules({ configPath });
    const site = result.rules.sites['www.example.com'];

    assert.equal(result.source, 'file');
    assert.equal(result.rules.mode, 2);
    assert.equal(result.rules.thresholds.suspect, 40);
    assert.equal(site.mode, 3);
    assert.equal(site.rateLimits.perMinute, 60);
    assert.ok(site.criticalPaths.includes('/custom-critical'));
    assert.ok(site.criticalPaths.includes('/site-critical'));
    assert.ok(site.exceptions.ips.includes('8.8.8.8'));
    assert.equal(result.rules.geoProfiles.unknownProfile, 'strict');
    assert.equal(site.geoProfiles.profiles.strict.rateFactor, 0.4);
    assert.deepEqual(result.rules.geoProfiles.countries.relaxed, ['BR', 'US', 'FR']);
});

test('falls back to defaults for invalid configuration', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'nodefw-rules-invalid-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const logger = { warn() {} };

    const invalidJson = join(dir, 'invalid.json');
    await writeFile(invalidJson, '{');
    const result = await loadClassificationRules({ configPath: invalidJson, logger });
    assert.equal(result.source, 'fallback');
    assert.equal(result.error, 'invalid_config');
    assert.equal(result.rules.mode, 1);

    const invalidMode = join(dir, 'mode.json');
    await writeFile(invalidMode, JSON.stringify({ mode: 9 }));
    const modeResult = await loadClassificationRules({ configPath: invalidMode, logger });
    assert.equal(modeResult.source, 'fallback');
});

test('rejects invalid geographic profiles, groups, factors and country codes', () => {
    const normalizeGeo = (geoProfiles) => normalizeRuleSet(
        mergeRuleSet(DEFAULT_RULES, { geoProfiles }, { appendArrays: false })
    );

    const invalid = [
        { enabled: 'yes' },
        { unknownProfile: 'relaxed' },
        { profiles: { custom: { rateFactor: 1 } } },
        { profiles: { strict: { rateFactor: 9 } } },
        { profiles: { relaxed: { rateFactor: 0.5 } } },
        { countries: { custom: ['BR'] } },
        { countries: { relaxed: ['BRA'] } },
        { countries: { relaxed: ['BR', 'BR'] } },
        { metadata: { updatedAt: '11/11/2026' } },
    ];

    for (const geoProfiles of invalid) {
        assert.throws(() => normalizeGeo(geoProfiles), /geoProfiles|geo profile|ISO|factor/);
    }

    const rules = normalizeGeo({});
    assert.equal(rules.geoProfiles.unknownProfile, 'standard');
    assert.ok(rules.geoProfiles.countries.strict.includes('SG'));
});

test('normalizes modes, countries and ASN arrays', () => {
    const rules = normalizeRuleSet({
        ...structuredClone(DEFAULT_RULES),
        mode: 2,
        countries: { home: ['br'], monitored: [] },
        hostingAsns: ['15169', 13335],
    });

    assert.equal(rules.mode, 2);
    assert.deepEqual(rules.countries.home, ['BR']);
    assert.deepEqual(rules.hostingAsns, [15169, 13335]);
    assert.throws(
        () => normalizeRuleSet({ ...structuredClone(DEFAULT_RULES), mode: 9 }),
        /mode/
    );
});

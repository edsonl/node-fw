import assert from 'node:assert/strict';
import test from 'node:test';

import { createClassifier } from '../src/classification/classifier.js';
import {
    DEFAULT_RULES,
    mergeRuleSet,
    normalizeRuleSet,
} from '../src/classification/rules.js';

const START = Date.parse('2026-11-10T12:00:00.000Z');

function makeRules(overrides = {}) {
    const base = normalizeRuleSet(structuredClone(DEFAULT_RULES));
    const rules = normalizeRuleSet(mergeRuleSet(base, overrides, { appendArrays: false }));

    if (overrides.sites) {
        for (const [site, siteOverrides] of Object.entries(overrides.sites)) {
            rules.sites[site] = normalizeRuleSet(
                mergeRuleSet(rules, siteOverrides, { appendArrays: true })
            );
        }
    }

    return rules;
}

function event(overrides = {}) {
    return {
        timestamp: '2026-11-10T12:00:00.000Z',
        receivedAt: new Date(START).toISOString(),
        site: 'www.example.com',
        ip: '8.8.8.8',
        method: 'GET',
        path: '/',
        status: 200,
        userAgent: 'Mozilla/5.0',
        country: 'BR',
        asn: 15169,
        asnOrg: 'Google LLC',
        ...overrides,
    };
}

function botVerifier(status = null) {
    const calls = [];
    return {
        calls,
        claimsBot(userAgent) {
            return /googlebot/i.test(userAgent) ? 'google' : null;
        },
        getStatus() {
            return status;
        },
        schedule(ip, userAgent) {
            calls.push({ ip, userAgent });
            return Promise.resolve(status);
        },
        getStats() {
            return { checks: calls.length };
        },
        close() {},
    };
}

test('normal traffic remains normal and country alone cannot block', () => {
    const classifier = createClassifier({ rules: makeRules() });
    const value = classifier.classify(event());

    assert.equal(value.score, 0);
    assert.equal(value.level, 'normal');
    assert.equal(value.mode, 1);
    assert.deepEqual(value.reasons, []);
    assert.equal(value.blockEligible, false);

    const foreign = classifier.classify(event({ ip: '1.1.1.1', country: 'US' }));
    assert.equal(foreign.score, 15);
    assert.equal(foreign.level, 'normal');
    assert.equal(foreign.blockEligible, false);
    assert.ok(foreign.reasons.includes('foreign_country:US'));
});

test('combines country, critical path and empty User-Agent into an explainable score', () => {
    const classifier = createClassifier({ rules: makeRules() });
    const value = classifier.classify(event({
        country: 'US',
        path: '/.env',
        userAgent: '',
    }));

    assert.equal(value.score, 45);
    assert.equal(value.level, 'observation');
    assert.ok(value.reasons.includes('foreign_country:US'));
    assert.ok(value.reasons.some((reason) => reason.startsWith('critical_path:')));
    assert.ok(value.reasons.includes('empty_user_agent'));
});

test('detects high request rate and 404 scanning', () => {
    const rules = makeRules({
        thresholds: { observation: 15, suspect: 30, critical: 70, block: 85 },
        weights: { rate10x: 60, notFoundRatio: 30 },
        rateLimits: { perMinute: 2, per5m: 1000, per15m: 1000, burst10s: 1000 },
    });
    const classifier = createClassifier({ rules });

    let value;
    for (let index = 0; index < 21; index += 1) {
        value = classifier.classify(event({
            status: 404,
            path: `/scan/${index}`,
            receivedAt: new Date(START + index * 1000).toISOString(),
        }));
    }

    assert.equal(value.score >= 70, true);
    assert.equal(value.level, 'critical');
    assert.ok(value.reasons.some((reason) => reason.startsWith('rate_1m:')));
    assert.ok(value.reasons.some((reason) => reason.startsWith('not_found_ratio:')));
});

test('verifies bots and rewards verified bots without allowing them to become critical', () => {
    const rules = makeRules({
        thresholds: { observation: 15, suspect: 30, critical: 60, block: 80 },
        weights: { rate10x: 80 },
        rateLimits: { perMinute: 1, per5m: 1000, per15m: 1000, burst10s: 1000 },
        botVerification: { rateMultiplier: 3 },
    });
    const verifier = botVerifier('verified');
    const classifier = createClassifier({ rules, botVerifier: verifier });

    let value;
    for (let index = 0; index < 20; index += 1) {
        value = classifier.classify(event({
            userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)',
            receivedAt: new Date(START + index * 1000).toISOString(),
        }));
    }

    assert.ok(value.reasons.includes('verified_bot:google'));
    assert.equal(value.blockEligible, false);
    assert.equal(value.level === 'critical', false);
});

test('penalizes a bot claim that fails verification and schedules unknown claims', () => {
    const failed = createClassifier({
        rules: makeRules(),
        botVerifier: botVerifier('failed'),
    }).classify(event({ userAgent: 'Googlebot/2.1' }));
    assert.ok(failed.reasons.includes('bot_claim_unverified:google'));
    assert.equal(failed.level, 'observation');

    const pendingVerifier = botVerifier(null);
    const pending = createClassifier({
        rules: makeRules(),
        botVerifier: pendingVerifier,
    }).classify(event({ userAgent: 'Googlebot/2.1' }));
    assert.ok(pending.reasons.includes('bot_claim_pending:google'));
    assert.equal(pendingVerifier.calls.length, 1);
});

test('applies IP, CIDR, ASN, path and verified-bot exceptions', () => {
    const ipClassifier = createClassifier({
        rules: makeRules({ exceptions: { ips: ['8.8.8.8'] } }),
    });
    const ipEvent = ipClassifier.classify(event({ country: 'US', path: '/.env' }));
    assert.equal(ipEvent.excluded, true);
    assert.deepEqual(ipEvent.reasons, ['exception_ip']);
    assert.equal(ipEvent.score, 0);

    const cidrClassifier = createClassifier({
        rules: makeRules({ exceptions: { cidrs: ['8.8.8.0/24'] } }),
    });
    assert.equal(cidrClassifier.classify(event()).reasons[0], 'exception_cidr');

    const asnClassifier = createClassifier({
        rules: makeRules({ exceptions: { asns: [15169] } }),
    });
    assert.equal(asnClassifier.classify(event()).reasons[0], 'exception_asn');

    const pathClassifier = createClassifier({
        rules: makeRules({ exceptions: { paths: ['/.env'] } }),
    });
    const pathEvent = pathClassifier.classify(event({ path: '/.env' }));
    assert.equal(pathEvent.excluded, true);
    assert.deepEqual(pathEvent.reasons, ['exception_path']);

    const verifiedClassifier = createClassifier({
        rules: makeRules({ exceptions: { verifiedBots: true } }),
        botVerifier: botVerifier('verified'),
    });
    const verifiedEvent = verifiedClassifier.classify(event({ userAgent: 'Googlebot/2.1' }));
    assert.equal(verifiedEvent.excluded, true);
    assert.deepEqual(verifiedEvent.reasons, ['exception_verified_bot']);
});

test('applies site override mode and computes block eligibility without blocking', () => {
    const rules = makeRules({
        mode: 1,
        thresholds: { observation: 10, suspect: 20, critical: 30, block: 40 },
        weights: { foreignCountry: 15, criticalPath: 20, emptyUserAgent: 10 },
        sites: {
            'www.example.com': {
                mode: 3,
            },
        },
    });
    const classifier = createClassifier({ rules });
    const value = classifier.classify(event({
        site: 'www.example.com',
        country: 'US',
        path: '/.env',
        userAgent: '',
    }));

    assert.equal(value.mode, 3);
    assert.equal(value.score, 45);
    assert.equal(value.blockEligible, true);
});

test('detects multi-site activity and decays reincidence over time', () => {
    const rules = makeRules({
        weights: { multiSite: 15 },
        multiSiteThreshold: 2,
        state: { decayPerMinute: 10 },
    });
    const classifier = createClassifier({ rules });

    classifier.classify(event({ site: 'a.example', receivedAt: new Date(START).toISOString() }));
    const multi = classifier.classify(event({
        site: 'b.example',
        receivedAt: new Date(START + 1000).toISOString(),
    }));
    assert.ok(multi.reasons.some((reason) => reason.startsWith('multi_site:')));

    const later = classifier.classify(event({
        site: 'a.example',
        receivedAt: new Date(START + 60 * 60_000).toISOString(),
    }));
    assert.equal(later.reasons.some((reason) => reason.startsWith('reincidence:')), false);
});

test('reports decisions, levels and exceptions in stats', () => {
    const classifier = createClassifier({ rules: makeRules() });
    classifier.classify(event());
    classifier.classify(event({ ip: '8.8.8.8', site: 'other.example' }));

    const stats = classifier.getStats();
    assert.equal(stats.decisions, 2);
    assert.equal(stats.trackedIps, 1);
    assert.equal(stats.levelCounts.normal, 2);
    assert.equal(stats.modeCounts[1], 2);
});

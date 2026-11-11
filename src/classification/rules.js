import { readFile } from 'node:fs/promises';

export const DEFAULT_RULES = Object.freeze({
    version: 1,
    mode: 1,
    thresholds: Object.freeze({
        observation: 25,
        suspect: 50,
        critical: 75,
        block: 85,
    }),
    minimumSignalsForBlock: 2,
    weights: Object.freeze({
        foreignCountry: 15,
        monitoredCountry: 5,
        hostingAsn: 10,
        rateAboveLimit: 10,
        rate3x: 20,
        rate10x: 35,
        rate5m: 15,
        rate15m: 15,
        burst: 15,
        notFoundRatio: 20,
        deniedRatio: 15,
        criticalPath: 20,
        criticalPathCap: 30,
        criticalPathRate: 10,
        emptyUserAgent: 10,
        authPost: 20,
        botClaimPending: 5,
        botClaimUnverified: 25,
        verifiedBot: -40,
        reincidence: 25,
        multiSite: 15,
    }),
    rateLimits: Object.freeze({
        perMinute: 120,
        per5m: 300,
        per15m: 600,
        burst10s: 20,
        criticalPathPerMinute: 10,
    }),
    countries: Object.freeze({
        home: Object.freeze(['BR']),
        monitored: Object.freeze([]),
    }),
    hostingAsns: Object.freeze([]),
    hostingOrgPatterns: Object.freeze([]),
    criticalPaths: Object.freeze([
        '/.env',
        '/.git',
        '/.aws',
        '/.ssh',
        '/wp-login.php',
        '/xmlrpc.php',
        '/wp-admin',
        '/admin',
        '/phpmyadmin',
        '/cgi-bin',
        '/vendor/phpunit',
        '/server-status',
    ]),
    authPaths: Object.freeze([
        '/wp-login.php',
        '/xmlrpc.php',
        '/admin',
        '/login',
        '/customer/account/login',
        '/checkout',
    ]),
    exceptions: Object.freeze({
        ips: Object.freeze([]),
        cidrs: Object.freeze([]),
        asns: Object.freeze([]),
        paths: Object.freeze([]),
        verifiedBots: false,
    }),
    botVerification: Object.freeze({
        googleRanges: Object.freeze([]),
        bingRanges: Object.freeze([]),
        cacheTtlMs: 86400000,
        maxEntries: 10000,
        rateMultiplier: 3,
    }),
    state: Object.freeze({
        maxTrackedIps: 50000,
        decayPerMinute: 1,
    }),
    multiSiteThreshold: 3,
    sites: Object.freeze({}),
});

function clone(value) {
    return structuredClone(value);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeObject(base, override) {
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (isPlainObject(value) && isPlainObject(base[key])) {
            result[key] = mergeObject(base[key], value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

function mergeArray(base, override) {
    return [...new Set([...(Array.isArray(base) ? base : []), ...override])];
}

export function mergeRuleSet(base, override, { appendArrays = true } = {}) {
    if (!isPlainObject(override)) {
        return clone(base);
    }

    const result = clone(base);
    const objectFields = [
        'thresholds',
        'weights',
        'rateLimits',
        'countries',
        'exceptions',
        'botVerification',
        'state',
    ];
    const arrayFields = [
        'hostingAsns',
        'hostingOrgPatterns',
        'criticalPaths',
        'authPaths',
    ];

    for (const [key, value] of Object.entries(override)) {
        if (key === 'sites') {
            result.sites = {
                ...(result.sites ?? {}),
                ...(isPlainObject(value) ? value : {}),
            };
            continue;
        }
        if (key === 'exceptions' && isPlainObject(value) && appendArrays) {
            const baseExceptions = result.exceptions ?? {};
            result.exceptions = {
                ...baseExceptions,
                ...value,
                ips: mergeArray(baseExceptions.ips, value.ips ?? []),
                cidrs: mergeArray(baseExceptions.cidrs, value.cidrs ?? []),
                asns: mergeArray(baseExceptions.asns, value.asns ?? []),
                paths: mergeArray(baseExceptions.paths, value.paths ?? []),
            };
            continue;
        }
        if (objectFields.includes(key) && isPlainObject(value)) {
            result[key] = mergeObject(result[key] ?? {}, value);
            continue;
        }
        if (arrayFields.includes(key) && Array.isArray(value)) {
            result[key] = appendArrays ? mergeArray(result[key], value) : [...value];
            continue;
        }
        result[key] = value;
    }

    return result;
}

function assertStringArray(value, field) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(`${field} must be an array of strings`);
    }
}

function assertNumber(value, field, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${field} must be a number between ${min} and ${max}`);
    }
}

function normalizeAsnArray(value, field) {
    if (!Array.isArray(value)) {
        throw new Error(`${field} must be an array`);
    }

    return value.map((item) => {
        const asn = Number(item);
        if (!Number.isInteger(asn) || asn < 1 || asn > 4294967295) {
            throw new Error(`${field} must contain valid ASNs`);
        }
        return asn;
    });
}

export function normalizeRuleSet(rules) {
    if (!isPlainObject(rules)) {
        throw new Error('classification rules must be an object');
    }

    const normalized = clone(rules);
    normalized.mode = Number(normalized.mode);
    if (![1, 2, 3].includes(normalized.mode)) {
        throw new Error('mode must be 1, 2 or 3');
    }

    for (const field of ['observation', 'suspect', 'critical', 'block']) {
        assertNumber(normalized.thresholds[field], `thresholds.${field}`, 0, 100);
    }
    const { observation, suspect, critical, block } = normalized.thresholds;
    if (!(observation < suspect && suspect < critical && critical <= block)) {
        throw new Error('thresholds must be observation < suspect < critical <= block');
    }

    assertNumber(normalized.minimumSignalsForBlock, 'minimumSignalsForBlock', 1, 10);
    for (const [key, value] of Object.entries(normalized.weights)) {
        assertNumber(value, `weights.${key}`, -100, 100);
    }
    for (const [key, value] of Object.entries(normalized.rateLimits)) {
        assertNumber(value, `rateLimits.${key}`, 1, 1000000);
    }

    for (const field of ['home', 'monitored']) {
        assertStringArray(normalized.countries[field], `countries.${field}`);
        normalized.countries[field] = normalized.countries[field].map((code) => code.toUpperCase());
    }

    normalized.hostingAsns = normalizeAsnArray(normalized.hostingAsns, 'hostingAsns');
    for (const field of ['hostingOrgPatterns', 'criticalPaths', 'authPaths']) {
        assertStringArray(normalized[field], field);
    }
    for (const field of ['ips', 'cidrs', 'paths']) {
        assertStringArray(normalized.exceptions[field], `exceptions.${field}`);
    }
    normalized.exceptions.asns = normalizeAsnArray(normalized.exceptions.asns, 'exceptions.asns');
    if (typeof normalized.exceptions.verifiedBots !== 'boolean') {
        throw new Error('exceptions.verifiedBots must be a boolean');
    }

    for (const field of ['googleRanges', 'bingRanges']) {
        assertStringArray(normalized.botVerification[field], `botVerification.${field}`);
    }
    assertNumber(normalized.botVerification.cacheTtlMs, 'botVerification.cacheTtlMs', 1000, 604800000);
    assertNumber(normalized.botVerification.maxEntries, 'botVerification.maxEntries', 100, 1000000);
    assertNumber(normalized.botVerification.rateMultiplier, 'botVerification.rateMultiplier', 1, 100);

    assertNumber(normalized.state.maxTrackedIps, 'state.maxTrackedIps', 100, 1000000);
    assertNumber(normalized.state.decayPerMinute, 'state.decayPerMinute', 0, 100);
    assertNumber(normalized.multiSiteThreshold, 'multiSiteThreshold', 1, 100);

    if (!isPlainObject(normalized.sites)) {
        throw new Error('sites must be an object');
    }

    return normalized;
}

export async function loadClassificationRules({ configPath, logger = null } = {}) {
    const defaults = normalizeRuleSet(clone(DEFAULT_RULES));

    if (!configPath) {
        return { rules: defaults, source: 'default' };
    }

    let text;
    try {
        text = await readFile(configPath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return { rules: defaults, source: 'default' };
        }
        logger?.warn({ code: error?.code ?? 'read_failed' }, 'classification config unavailable; using defaults');
        return { rules: defaults, source: 'fallback', error: 'read_failed' };
    }

    try {
        const parsed = JSON.parse(text);
        const merged = mergeRuleSet(defaults, parsed, { appendArrays: false });
        const rules = normalizeRuleSet(merged);

        const normalizedSites = {};
        for (const [site, siteRules] of Object.entries(rules.sites)) {
            if (!isPlainObject(siteRules)) {
                throw new Error(`site ${site} must be an object`);
            }
            const siteKey = site.trim().toLowerCase();
            if (siteKey === '') {
                throw new Error('site keys must not be empty');
            }
            normalizedSites[siteKey] = normalizeRuleSet(
                mergeRuleSet(rules, siteRules, { appendArrays: true })
            );
        }
        rules.sites = normalizedSites;

        return { rules, source: 'file' };
    } catch (error) {
        logger?.warn({ code: 'invalid_config' }, 'classification config is invalid; using defaults');
        return { rules: defaults, source: 'fallback', error: 'invalid_config' };
    }
}

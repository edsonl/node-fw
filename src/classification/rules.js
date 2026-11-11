import { readFile } from 'node:fs/promises';

export const GEO_PROFILE_NAMES = Object.freeze(['relaxed', 'standard', 'strict']);
export const GEO_PROFILE_PRECEDENCE = Object.freeze(['strict', 'standard', 'relaxed']);

const GEO_PROFILE_SET = new Set(GEO_PROFILE_NAMES);
const GEO_FACTOR_MIN = 0.1;
const GEO_FACTOR_MAX = 3;

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
    geoProfiles: Object.freeze({
        enabled: true,
        unknownProfile: 'standard',
        profiles: Object.freeze({
            relaxed: Object.freeze({ rateFactor: 1.5 }),
            standard: Object.freeze({ rateFactor: 1 }),
            strict: Object.freeze({ rateFactor: 0.5 }),
        }),
        countries: Object.freeze({
            relaxed: Object.freeze(['BR', 'US']),
            standard: Object.freeze([
                'AD', 'AL', 'AT', 'BA', 'BE', 'BG', 'BY', 'CH', 'CZ', 'DE',
                'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE',
                'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK',
                'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'RU', 'SE', 'SI',
                'SK', 'SM', 'UA', 'VA',
            ]),
            strict: Object.freeze([
                'AE', 'AF', 'AM', 'AZ', 'BD', 'BH', 'BN', 'BT', 'CN', 'CY',
                'DJ', 'DZ', 'EG', 'GE', 'HK', 'ID', 'IL', 'IN', 'IQ', 'IR',
                'JO', 'JP', 'KG', 'KH', 'KM', 'KP', 'KR', 'KW', 'KZ', 'LA',
                'LB', 'LK', 'LY', 'MA', 'MM', 'MN', 'MO', 'MR', 'MV', 'MY',
                'NP', 'OM', 'PH', 'PK', 'PS', 'QA', 'RU', 'SA', 'SD', 'SG',
                'SO', 'SY', 'TH', 'TJ', 'TL', 'TM', 'TN', 'TR', 'TW', 'UZ',
                'VN', 'YE',
            ]),
        }),
        metadata: Object.freeze({
            version: 1,
            updatedAt: '2026-11-11',
            sources: Object.freeze([
                'UN M49 - Europa e Ásia (ISO 3166-1 alpha-2), consultado em 2026-11-11',
                'Liga Árabe - 22 Estados-membros (ISO 3166-1 alpha-2), consultado em 2026-11-11',
                'Rússia incluída explicitamente no perfil strict',
            ]),
            notes: 'Sobreposições resolvidas por strict > standard > relaxed; localização não adiciona score.',
        }),
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
        'geoProfiles',
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

function normalizeGeoCountryList(value, field) {
    assertStringArray(value, field);

    const codes = value.map((item) => item.trim().toUpperCase());
    if (codes.some((code) => !/^[A-Z]{2}$/.test(code))) {
        throw new Error(`${field} must contain ISO 3166-1 alpha-2 codes`);
    }
    if (new Set(codes).size !== codes.length) {
        throw new Error(`${field} must not contain duplicate codes`);
    }

    return codes;
}

function normalizeGeoProfiles(value) {
    if (!isPlainObject(value)) {
        throw new Error('geoProfiles must be an object');
    }
    if (typeof value.enabled !== 'boolean') {
        throw new Error('geoProfiles.enabled must be a boolean');
    }
    if (!isPlainObject(value.profiles)) {
        throw new Error('geoProfiles.profiles must be an object');
    }
    if (Object.keys(value.profiles).some((name) => !GEO_PROFILE_SET.has(name))) {
        throw new Error('geoProfiles.profiles contains an unknown profile');
    }

    const profiles = {};
    for (const name of GEO_PROFILE_NAMES) {
        const profile = value.profiles[name];
        if (!isPlainObject(profile)) {
            throw new Error(`geoProfiles.profiles.${name} must be an object`);
        }
        if (Object.keys(profile).some((key) => key !== 'rateFactor')) {
            throw new Error(`geoProfiles.profiles.${name} contains an unknown field`);
        }
        assertNumber(
            profile.rateFactor,
            `geoProfiles.profiles.${name}.rateFactor`,
            GEO_FACTOR_MIN,
            GEO_FACTOR_MAX
        );
        profiles[name] = { rateFactor: profile.rateFactor };
    }

    if (!(profiles.relaxed.rateFactor >= profiles.standard.rateFactor
        && profiles.standard.rateFactor >= profiles.strict.rateFactor)) {
        throw new Error('geo profile factors must satisfy relaxed >= standard >= strict');
    }

    if (typeof value.unknownProfile !== 'string' || !GEO_PROFILE_SET.has(value.unknownProfile)) {
        throw new Error('geoProfiles.unknownProfile must be a known profile');
    }
    if (value.unknownProfile === 'relaxed') {
        throw new Error('geoProfiles.unknownProfile must be standard or strict');
    }

    if (!isPlainObject(value.countries)) {
        throw new Error('geoProfiles.countries must be an object');
    }
    if (Object.keys(value.countries).some((name) => !GEO_PROFILE_SET.has(name))) {
        throw new Error('geoProfiles.countries contains an unknown profile');
    }

    const countries = {};
    for (const name of GEO_PROFILE_NAMES) {
        countries[name] = normalizeGeoCountryList(
            value.countries[name],
            `geoProfiles.countries.${name}`
        );
    }

    if (!isPlainObject(value.metadata)) {
        throw new Error('geoProfiles.metadata must be an object');
    }
    if (!Number.isInteger(value.metadata.version) || value.metadata.version < 1) {
        throw new Error('geoProfiles.metadata.version must be a positive integer');
    }
    if (typeof value.metadata.updatedAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}$/.test(value.metadata.updatedAt)) {
        throw new Error('geoProfiles.metadata.updatedAt must use YYYY-MM-DD');
    }
    assertStringArray(value.metadata.sources, 'geoProfiles.metadata.sources');
    if (value.metadata.sources.length === 0) {
        throw new Error('geoProfiles.metadata.sources must not be empty');
    }
    if (typeof value.metadata.notes !== 'string') {
        throw new Error('geoProfiles.metadata.notes must be a string');
    }

    return {
        enabled: value.enabled,
        unknownProfile: value.unknownProfile,
        profiles,
        countries,
        metadata: {
            version: value.metadata.version,
            updatedAt: value.metadata.updatedAt,
            sources: [...value.metadata.sources],
            notes: value.metadata.notes,
        },
    };
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

    normalized.geoProfiles = normalizeGeoProfiles(normalized.geoProfiles);

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

import { isIP } from 'node:net';
import { join } from 'node:path';

import { open as openMaxMind } from 'maxmind';

import { getIpScope } from '../utils/ip.js';
import { MAXMIND_EDITIONS } from './maxmind-editions.js';

const MAX_ASN_ORGANIZATION_LENGTH = 128;
const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F]/g;

function nowIso() {
    return new Date().toISOString();
}

function safeErrorCode(error) {
    if (error && typeof error.code === 'string') {
        return error.code;
    }
    if (error && typeof error.name === 'string' && error.name !== 'Error') {
        return error.name;
    }
    return 'open_failed';
}

function normalizeCountry(record) {
    const code = record?.country?.iso_code ?? record?.registered_country?.iso_code;
    return typeof code === 'string' && /^[A-Za-z]{2}$/.test(code)
        ? code.toUpperCase()
        : null;
}

function normalizeAsn(record) {
    const number = record?.autonomous_system_number;
    const organization = record?.autonomous_system_organization;

    if (!Number.isInteger(number) || number <= 0) {
        return { asn: null, asnOrg: null };
    }

    const org = typeof organization === 'string'
        ? organization.replace(CONTROL_CHARS_PATTERN, ' ').trim().slice(0, MAX_ASN_ORGANIZATION_LENGTH)
        : '';

    return {
        asn: number,
        asnOrg: org === '' ? null : org,
    };
}

function applyGeo(event, geo) {
    event.country = geo.country;
    event.asn = geo.asn;
    event.asnOrg = geo.asnOrg;
    return event;
}

export function createMaxMindEnricher({
    config,
    logger = null,
    openDatabase = openMaxMind,
    now = () => Date.now(),
} = {}) {
    if (!config) {
        throw new Error('MaxMind config is required');
    }

    const cache = new Map();
    const readers = {
        country: null,
        asn: null,
    };
    const stats = {
        enabled: Boolean(config.enabled),
        countryReady: false,
        asnReady: false,
        cacheEntries: 0,
        cacheMaxEntries: config.cacheMaxEntries,
        lookups: 0,
        cacheHits: 0,
        cacheMisses: 0,
        privateSkips: 0,
        invalidSkips: 0,
        lookupErrors: 0,
        countryHits: 0,
        asnHits: 0,
        lastError: null,
        startedAt: null,
    };

    let started = false;

    function setLastError(edition, error) {
        stats.lastError = {
            edition,
            code: safeErrorCode(error),
            at: nowIso(),
        };
    }

    async function openReaderSafely(edition) {
        const filePath = join(config.dbDir, edition.fileName);
        try {
            const reader = await openDatabase(filePath);
            if (!reader || typeof reader.get !== 'function') {
                throw new Error('invalid reader');
            }
            return reader;
        } catch (error) {
            setLastError(edition.name, error);
            logger?.warn(
                { edition: edition.name, code: safeErrorCode(error) },
                'maxmind database unavailable'
            );
            return null;
        }
    }

    async function start() {
        if (!stats.enabled) {
            logger?.info('maxmind enrichment disabled');
            return getStats();
        }
        if (started) {
            return getStats();
        }
        started = true;
        stats.startedAt = nowIso();

        const [country, asn] = await Promise.all([
            openReaderSafely(MAXMIND_EDITIONS[0]),
            openReaderSafely(MAXMIND_EDITIONS[1]),
        ]);

        readers.country = country;
        readers.asn = asn;
        stats.countryReady = Boolean(country);
        stats.asnReady = Boolean(asn);

        logger?.info(
            { countryReady: stats.countryReady, asnReady: stats.asnReady },
            stats.countryReady && stats.asnReady
                ? 'maxmind enrichment ready'
                : 'maxmind enrichment degraded'
        );

        return getStats();
    }

    function cacheGet(ip) {
        const entry = cache.get(ip);
        if (!entry) {
            return null;
        }
        if (entry.expiresAt <= now()) {
            cache.delete(ip);
            return null;
        }

        stats.cacheHits += 1;
        return entry.value;
    }

    function cacheSet(ip, value) {
        cache.set(ip, {
            value,
            expiresAt: now() + config.cacheTtlMs,
        });

        while (cache.size > config.cacheMaxEntries) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            cache.delete(oldest);
        }
    }

    function lookup(ip) {
        let country = null;
        let asn = null;
        let asnOrg = null;

        if (readers.country) {
            try {
                country = normalizeCountry(readers.country.get(ip));
                if (country) {
                    stats.countryHits += 1;
                }
            } catch {
                stats.lookupErrors += 1;
            }
        }

        if (readers.asn) {
            try {
                const normalized = normalizeAsn(readers.asn.get(ip));
                asn = normalized.asn;
                asnOrg = normalized.asnOrg;
                if (asn) {
                    stats.asnHits += 1;
                }
            } catch {
                stats.lookupErrors += 1;
            }
        }

        return { country, asn, asnOrg };
    }

    function enrich(event) {
        event.country = null;
        event.asn = null;
        event.asnOrg = null;

        if (!stats.enabled || (!readers.country && !readers.asn)) {
            return event;
        }
        if (typeof event.ip !== 'string' || isIP(event.ip) === 0) {
            stats.invalidSkips += 1;
            return event;
        }
        if (getIpScope(event.ip) !== 'public') {
            stats.privateSkips += 1;
            return event;
        }

        stats.lookups += 1;
        const cached = cacheGet(event.ip);
        if (cached) {
            return applyGeo(event, cached);
        }

        stats.cacheMisses += 1;
        const value = lookup(event.ip);
        cacheSet(event.ip, value);
        return applyGeo(event, value);
    }

    async function reload() {
        if (!stats.enabled || !started) {
            return getStats();
        }

        const [country, asn] = await Promise.all([
            openReaderSafely(MAXMIND_EDITIONS[0]),
            openReaderSafely(MAXMIND_EDITIONS[1]),
        ]);

        if (country) {
            readers.country = country;
        }
        if (asn) {
            readers.asn = asn;
        }

        stats.countryReady = Boolean(readers.country);
        stats.asnReady = Boolean(readers.asn);
        cache.clear();
        stats.cacheEntries = 0;

        logger?.info(
            { countryReady: stats.countryReady, asnReady: stats.asnReady },
            'maxmind readers reloaded'
        );

        return getStats();
    }

    async function close() {
        readers.country = null;
        readers.asn = null;
        cache.clear();
        stats.countryReady = false;
        stats.asnReady = false;
        stats.cacheEntries = 0;
        started = false;
    }

    function getStats() {
        return {
            ...stats,
            cacheEntries: cache.size,
            ready: stats.enabled && stats.countryReady && stats.asnReady,
            degraded: stats.enabled && (!stats.countryReady || !stats.asnReady),
        };
    }

    return {
        start,
        enrich,
        reload,
        close,
        getStats,
    };
}

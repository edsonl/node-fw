import { isIP } from 'node:net';

import { bucketFor, UNIQUE_WINDOWS, WINDOWS } from './aggregation-plan.js';
import { InvalidQueryError } from './errors.js';
import { createKeyBuilder } from './keys.js';

const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const MAX_HOSTNAME_LENGTH = 253;
const DEFAULT_EVENT_PAGE_SIZE = 50;
const MAX_EVENT_PAGE_SIZE = 100;
const MAX_EVENT_SCAN = 1000;
const MAX_EVENT_USER_AGENT_LENGTH = 160;
const MAX_EVENT_PATH_LENGTH = 2048;
const STREAM_ID_PATTERN = /^\d+-\d+$/;
const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F]/g;
const LEVELS = new Set(['normal', 'observation', 'suspect', 'critical']);

function normalizeSiteFilter(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    if (typeof value !== 'string') {
        throw new InvalidQueryError('site must be a string');
    }

    let site = value.trim().toLowerCase();
    if (site.endsWith('.')) {
        site = site.slice(0, -1);
    }
    if (site.startsWith('[') && site.endsWith(']')) {
        site = site.slice(1, -1);
    }

    if (isIP(site) !== 0) {
        return site;
    }
    if (site.length > MAX_HOSTNAME_LENGTH || !HOSTNAME_PATTERN.test(site)) {
        throw new InvalidQueryError('site must be a valid hostname or IP address');
    }

    return site;
}

function toNumber(value) {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
}

function toStatusCounts(reply) {
    const counts = {};
    if (!reply || typeof reply !== 'object') {
        return counts;
    }

    for (const [status, count] of Object.entries(reply)) {
        counts[status] = toNumber(count);
    }

    return counts;
}

function toRanking(reply, fieldName) {
    if (!Array.isArray(reply)) {
        return [];
    }

    return reply.map((entry) => ({
        [fieldName]: entry.value,
        count: toNumber(entry.score),
    }));
}

function assertReplies(replies) {
    if (!Array.isArray(replies)) {
        throw new Error('Redis returned an invalid batch response');
    }

    const error = replies.find((reply) => reply instanceof Error);
    if (error) {
        throw error;
    }
}

function readSingleValue(value, field) {
    if (Array.isArray(value)) {
        throw new InvalidQueryError(`${field} must be a single value`);
    }
    return value;
}

function parsePageSize(value) {
    const single = readSingleValue(value, 'limit');
    if (single === undefined || single === null || single === '') {
        return DEFAULT_EVENT_PAGE_SIZE;
    }

    const text = String(single).trim();
    if (!/^\d+$/.test(text)) {
        throw new InvalidQueryError('limit must be an integer');
    }

    const limit = Number(text);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE_SIZE) {
        throw new InvalidQueryError(`limit must be between 1 and ${MAX_EVENT_PAGE_SIZE}`);
    }

    return limit;
}

function parseCursor(value) {
    const single = readSingleValue(value, 'cursor');
    if (single === undefined || single === null || single === '') {
        return null;
    }
    if (typeof single !== 'string' || !STREAM_ID_PATTERN.test(single)) {
        throw new InvalidQueryError('cursor must be a valid stream ID');
    }

    return single;
}

function parseIpFilter(value) {
    const single = readSingleValue(value, 'ip');
    if (single === undefined || single === null || single === '') {
        return null;
    }
    if (typeof single !== 'string') {
        throw new InvalidQueryError('ip must be a string');
    }

    const ip = single.trim().toLowerCase();
    if (ip.length > 64 || isIP(ip) === 0) {
        throw new InvalidQueryError('ip must be a valid IPv4 or IPv6 address');
    }

    return ip;
}

function parseStatusFilter(value) {
    const single = readSingleValue(value, 'status');
    if (single === undefined || single === null || single === '') {
        return null;
    }

    const text = String(single).trim();
    if (!/^\d+$/.test(text)) {
        throw new InvalidQueryError('status must be an integer');
    }

    const status = Number(text);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new InvalidQueryError('status must be between 100 and 599');
    }

    return status;
}

function cleanText(value, maxLength) {
    if (value === undefined || value === null) {
        return '';
    }

    return String(value)
        .replace(CONTROL_CHARS_PATTERN, ' ')
        .trim()
        .slice(0, maxLength);
}

function cleanPath(value) {
    let path = cleanText(value, 8192);
    const queryIndex = path.indexOf('?');
    if (queryIndex !== -1) {
        path = path.slice(0, queryIndex);
    }

    return path.slice(0, MAX_EVENT_PATH_LENGTH);
}

function toOptionalInteger(value, min, max) {
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function toOptionalNumber(value, min, max) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function parseReasons(value) {
    if (typeof value !== 'string' || value.length > 4096) {
        return [];
    }

    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed
            .slice(0, 50)
            .filter((reason) => typeof reason === 'string')
            .map((reason) => cleanText(reason, 160))
            .filter(Boolean);
    } catch {
        return [];
    }
}

function eventFromStreamEntry(entry) {
    const message = entry.message instanceof Map
        ? Object.fromEntries(entry.message)
        : (entry.message ?? {});
    const rawUserAgent = message.userAgent;
    const rawCountry = cleanText(message.country, 2);
    const level = cleanText(message.level, 16).toLowerCase();
    const geoProfile = cleanText(message.geoProfile, 16).toLowerCase();

    return {
        id: String(entry.id),
        timestamp: cleanText(message.timestamp, 64),
        receivedAt: cleanText(message.receivedAt, 64),
        site: cleanText(message.site, MAX_HOSTNAME_LENGTH),
        ip: cleanText(message.ip, 64),
        method: cleanText(message.method, 16),
        path: cleanPath(message.path),
        finalUri: cleanPath(message.finalUri),
        status: toOptionalInteger(message.status, 100, 599),
        requestTime: toOptionalNumber(message.requestTime, 0, 86400),
        dynamic: message.dynamic === '1' || message.dynamic === 1,
        userAgent: cleanText(rawUserAgent, MAX_EVENT_USER_AGENT_LENGTH),
        userAgentTruncated: typeof rawUserAgent === 'string'
            && rawUserAgent.length > MAX_EVENT_USER_AGENT_LENGTH,
        country: /^[A-Za-z]{2}$/.test(rawCountry) ? rawCountry.toUpperCase() : null,
        asn: toOptionalInteger(message.asn, 1, 4_294_967_295),
        asnOrg: cleanText(message.asnOrg, 128) || null,
        geoProfile: ['relaxed', 'standard', 'strict'].includes(geoProfile) ? geoProfile : null,
        geoFactor: toOptionalNumber(message.geoFactor, 0.1, 3),
        geoFallback: message.geoFallback === '1',
        score: toOptionalInteger(message.score, 0, 100),
        level: LEVELS.has(level) ? level : null,
        reasons: parseReasons(message.reasons),
        mode: toOptionalInteger(message.mode, 1, 3),
        blockEligible: message.blockEligible === '1',
        excluded: message.excluded === '1',
    };
}

export function createRedisQueries({ redis, config }) {
    const keys = createKeyBuilder(config.prefix);

    async function getSummary({ site: siteFilter, now = new Date() } = {}) {
        redis.assertReady();

        const site = normalizeSiteFilter(siteFilter);
        const current = now instanceof Date ? now : new Date(now);
        if (Number.isNaN(current.getTime())) {
            throw new InvalidQueryError('now must be a valid date');
        }

        const buckets = Object.fromEntries(
            WINDOWS.map((window) => [window.label, bucketFor(current, window.seconds)])
        );
        const multi = redis.client.multi();
        const fields = [];

        function add(field, command) {
            fields.push(field);
            command(multi);
        }

        for (const window of WINDOWS) {
            add(`global.requests.${window.label}`, (m) => m.get(
                keys.globalRate(window.label, buckets[window.label])
            ));
            add(`global.dynamic.${window.label}`, (m) => m.get(
                keys.globalDynamic(window.label, buckets[window.label])
            ));
        }

        for (const window of UNIQUE_WINDOWS) {
            add(`global.unique.${window.label}`, (m) => m.pfCount(
                keys.globalUnique(window.label, buckets[window.label])
            ));
        }

        add('global.status.1m', (m) => m.hGetAll(
            keys.globalStatus('1m', buckets['1m'])
        ));
        add('global.topCountries', (m) => m.zRangeWithScores(
            keys.globalCountry('1m', buckets['1m']),
            0,
            9
        ));
        add('global.topIps', (m) => m.zRangeWithScores(
            keys.globalIpRank('1m', buckets['1m']),
            0,
            9
        ));

        if (site) {
            for (const window of WINDOWS) {
                add(`site.requests.${window.label}`, (m) => m.get(
                    keys.siteRate(site, window.label, buckets[window.label])
                ));
                add(`site.dynamic.${window.label}`, (m) => m.get(
                    keys.siteDynamic(site, window.label, buckets[window.label])
                ));
            }

            for (const window of UNIQUE_WINDOWS) {
                add(`site.unique.${window.label}`, (m) => m.pfCount(
                    keys.siteUnique(site, window.label, buckets[window.label])
                ));
            }

            add('site.status.1m', (m) => m.hGetAll(
                keys.siteStatus(site, '1m', buckets['1m'])
            ));
            add('site.topCountries', (m) => m.zRangeWithScores(
                keys.siteCountry(site, '1m', buckets['1m']),
                0,
                9
            ));
            add('site.topIps', (m) => m.zRangeWithScores(
                keys.siteIpRank(site, '1m', buckets['1m']),
                0,
                9
            ));
        }

        const replies = await multi.exec();
        assertReplies(replies);

        const values = Object.fromEntries(fields.map((field, index) => [field, replies[index]]));
        const global = {
            requests: Object.fromEntries(WINDOWS.map((window) => [
                window.label,
                toNumber(values[`global.requests.${window.label}`]),
            ])),
            dynamic: Object.fromEntries(WINDOWS.map((window) => [
                window.label,
                toNumber(values[`global.dynamic.${window.label}`]),
            ])),
            unique: Object.fromEntries(UNIQUE_WINDOWS.map((window) => [
                window.label,
                toNumber(values[`global.unique.${window.label}`]),
            ])),
            status: toStatusCounts(values['global.status.1m']),
            topCountries: toRanking(values['global.topCountries'], 'country'),
            topIps: toRanking(values['global.topIps'], 'ip'),
        };

        const siteSummary = site
            ? {
                name: site,
                requests: Object.fromEntries(WINDOWS.map((window) => [
                    window.label,
                    toNumber(values[`site.requests.${window.label}`]),
                ])),
                dynamic: Object.fromEntries(WINDOWS.map((window) => [
                    window.label,
                    toNumber(values[`site.dynamic.${window.label}`]),
                ])),
                unique: Object.fromEntries(UNIQUE_WINDOWS.map((window) => [
                    window.label,
                    toNumber(values[`site.unique.${window.label}`]),
                ])),
                status: toStatusCounts(values['site.status.1m']),
                topCountries: toRanking(values['site.topCountries'], 'country'),
                topIps: toRanking(values['site.topIps'], 'ip'),
            }
            : null;

        return {
            timestamp: current.toISOString(),
            buckets,
            global,
            site: siteSummary,
        };
    }

    async function getRecentEvents({
        site: siteFilter,
        ip: ipFilter,
        status: statusFilter,
        cursor,
        limit,
    } = {}) {
        redis.assertReady();

        const site = normalizeSiteFilter(siteFilter);
        const ip = parseIpFilter(ipFilter);
        const status = parseStatusFilter(statusFilter);
        const pageSize = parsePageSize(limit);
        const cursorId = parseCursor(cursor);
        const scanCount = Math.min(MAX_EVENT_SCAN, Math.max(pageSize * 10, pageSize + 1));

        const entries = await redis.client.xRevRange(
            keys.eventStream(),
            cursorId ?? '+',
            '-',
            { COUNT: scanCount }
        );

        const list = (entries ?? []).filter((entry) => !cursorId || String(entry.id) !== cursorId);
        const events = [];

        for (const entry of list) {
            const event = eventFromStreamEntry(entry);
            if (site && event.site.toLowerCase() !== site) {
                continue;
            }
            if (ip && event.ip.toLowerCase() !== ip) {
                continue;
            }
            if (status !== null && event.status !== status) {
                continue;
            }
            events.push(event);
        }

        let selected = events;
        let nextCursor = null;
        let hasMore = false;

        if (events.length > pageSize) {
            selected = events.slice(0, pageSize);
            nextCursor = selected[selected.length - 1].id;
            hasMore = true;
        } else if (list.length >= scanCount) {
            nextCursor = String(list[list.length - 1].id);
            hasMore = true;
        }

        return {
            timestamp: new Date().toISOString(),
            events: selected,
            page: {
                limit: pageSize,
                count: selected.length,
                hasMore,
                nextCursor,
                scanned: list.length,
            },
        };
    }

    return {
        getSummary,
        getRecentEvents,
    };
}

import { isIP } from 'node:net';

import { bucketFor, UNIQUE_WINDOWS, WINDOWS } from './aggregation-plan.js';
import { InvalidQueryError } from './errors.js';
import { createKeyBuilder } from './keys.js';

const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const MAX_HOSTNAME_LENGTH = 253;

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

    return {
        getSummary,
    };
}

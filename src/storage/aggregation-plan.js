import { createKeyBuilder } from './keys.js';

export const WINDOWS = Object.freeze([
    Object.freeze({ label: '1s', seconds: 1, ip: false }),
    Object.freeze({ label: '1m', seconds: 60, ip: true }),
    Object.freeze({ label: '5m', seconds: 300, ip: true }),
    Object.freeze({ label: '15m', seconds: 900, ip: true }),
]);

export const UNIQUE_WINDOWS = WINDOWS.filter((window) => window.label !== '1s');
const REPUTATION_TTL_SECONDS = 30 * 24 * 60 * 60;
const IP_SITES_TTL_SECONDS = 24 * 60 * 60;
const SUSPECTS_TTL_SECONDS = 30 * 24 * 60 * 60;

function toDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function bucketFor(date, seconds) {
    return Math.floor(toDate(date).getTime() / 1000 / seconds) * seconds;
}

export function ttlForWindow(seconds) {
    return Math.max(seconds * 2, 60);
}

function addCounter(counters, key, amount, ttl) {
    const current = counters.get(key);
    if (current) {
        current.amount += amount;
        return;
    }

    counters.set(key, { key, amount, ttl });
}

function addZset(zsets, key, member, amount, ttl) {
    let entry = zsets.get(key);
    if (!entry) {
        entry = { key, ttl, members: new Map() };
        zsets.set(key, entry);
    }
    entry.members.set(member, (entry.members.get(member) ?? 0) + amount);
}

function addScoredZset(scoredZsets, key, member, score, ttl) {
    let entry = scoredZsets.get(key);
    if (!entry) {
        entry = { key, ttl, members: new Map() };
        scoredZsets.set(key, entry);
    }
    entry.members.set(member, Math.max(entry.members.get(member) ?? -Infinity, score));
}

function addHash(hashes, key, field, amount, ttl) {
    let entry = hashes.get(key);
    if (!entry) {
        entry = { key, ttl, fields: new Map() };
        hashes.set(key, entry);
    }
    entry.fields.set(field, (entry.fields.get(field) ?? 0) + amount);
}

function addHll(hlls, key, member, ttl) {
    let entry = hlls.get(key);
    if (!entry) {
        entry = { key, ttl, members: new Set() };
        hlls.set(key, entry);
    }
    entry.members.add(member);
}

function addSet(sets, key, member, ttl) {
    let entry = sets.get(key);
    if (!entry) {
        entry = { key, ttl, members: new Set() };
        sets.set(key, entry);
    }
    entry.members.add(member);
}

function streamFields(event) {
    return [
        'timestamp', event.timestamp,
        'receivedAt', event.receivedAt,
        'requestId', event.requestId ?? '',
        'site', event.site,
        'ip', event.ip,
        'ipScope', event.ipScope ?? '',
        'method', event.method,
        'path', event.path,
        'finalUri', event.finalUri ?? '',
        'status', String(event.status),
        'requestTime', String(event.requestTime),
        'upstreamAddress', event.upstreamAddress ?? '',
        'upstreamTime', event.upstreamTime ?? '',
        'dynamic', event.dynamic ? '1' : '0',
        'scheme', event.scheme ?? '',
        'bodyBytesSent', String(event.bodyBytesSent ?? 0),
        'userAgent', event.userAgent ?? '',
        'country', event.country ?? '',
        'asn', event.asn === undefined || event.asn === null ? '' : String(event.asn),
        'asnOrg', event.asnOrg ?? '',
        'geoProfile', event.geoProfile ?? '',
        'geoFactor', String(Number.isFinite(event.geoFactor) ? event.geoFactor : 1),
        'geoFallback', event.geoFallback ? '1' : '0',
        'score', String(Number.isFinite(event.score) ? event.score : 0),
        'level', event.level ?? 'normal',
        'reasons', JSON.stringify(Array.isArray(event.reasons) ? event.reasons : []),
        'mode', String(event.mode ?? 1),
        'blockEligible', event.blockEligible ? '1' : '0',
        'excluded', event.excluded ? '1' : '0',
    ];
}

export function buildAggregationPlan(events, options) {
    const {
        prefix,
        eventStreamEnabled = true,
        eventStreamMaxlen = 50000,
        now = new Date(),
    } = options ?? {};

    const keys = createKeyBuilder(prefix);
    const counters = new Map();
    const zsets = new Map();
    const scoredZsets = new Map();
    const hashes = new Map();
    const hlls = new Map();
    const sets = new Map();
    const reputations = new Map();
    const streams = [];

    for (const event of events) {
        const receivedAt = event.receivedAt ?? now.toISOString();
        const date = toDate(receivedAt);
        const site = event.site;
        const ip = event.ip;
        const status = String(event.status);
        const country = typeof event.country === 'string' && event.country.trim() !== ''
            ? event.country.trim().toUpperCase()
            : null;

        for (const window of WINDOWS) {
            const bucket = bucketFor(date, window.seconds);
            const ttl = ttlForWindow(window.seconds);

            addCounter(counters, keys.globalRate(window.label, bucket), 1, ttl);
            addCounter(counters, keys.siteRate(site, window.label, bucket), 1, ttl);
            addHash(hashes, keys.globalStatus(window.label, bucket), status, 1, ttl);
            addHash(hashes, keys.siteStatus(site, window.label, bucket), status, 1, ttl);

            if (event.dynamic) {
                addCounter(counters, keys.globalDynamic(window.label, bucket), 1, ttl);
                addCounter(counters, keys.siteDynamic(site, window.label, bucket), 1, ttl);
            }

            if (country) {
                addZset(zsets, keys.globalCountry(window.label, bucket), country, 1, ttl);
                addZset(zsets, keys.siteCountry(site, window.label, bucket), country, 1, ttl);
            }

            if (window.ip) {
                addCounter(counters, keys.ipRate(ip, window.label, bucket), 1, ttl);
                addCounter(counters, keys.ipSiteRate(ip, site, window.label, bucket), 1, ttl);
                addZset(zsets, keys.globalIpRank(window.label, bucket), ip, 1, ttl);
                addZset(zsets, keys.siteIpRank(site, window.label, bucket), ip, 1, ttl);
            }
        }

        for (const window of UNIQUE_WINDOWS) {
            const bucket = bucketFor(date, window.seconds);
            const ttl = ttlForWindow(window.seconds);
            addHll(hlls, keys.globalUnique(window.label, bucket), ip, ttl);
            addHll(hlls, keys.siteUnique(site, window.label, bucket), ip, ttl);
        }

        addSet(sets, keys.ipSites(ip), site, IP_SITES_TTL_SECONDS);

        const reputationKey = keys.reputation(ip);
        let reputation = reputations.get(reputationKey);
        if (!reputation) {
            reputation = {
                key: reputationKey,
                ip,
                count: 0,
                firstSeen: receivedAt,
                lastSeen: receivedAt,
                lastSite: site,
                lastStatus: event.status,
                lastMethod: event.method,
                lastCountry: country,
                lastGeoProfile: event.geoProfile ?? null,
                lastGeoFactor: Number.isFinite(event.geoFactor) ? event.geoFactor : 1,
                lastGeoFallback: Boolean(event.geoFallback),
                score: Number.isFinite(event.score) ? event.score : 0,
                level: event.level ?? 'normal',
                reasons: JSON.stringify(Array.isArray(event.reasons) ? event.reasons : []),
                scoredAt: receivedAt,
                ttl: REPUTATION_TTL_SECONDS,
            };
            reputations.set(reputationKey, reputation);
        } else {
            const receivedTime = Date.parse(receivedAt);
            if (receivedTime < Date.parse(reputation.firstSeen)) {
                reputation.firstSeen = receivedAt;
            }
            if (receivedTime >= Date.parse(reputation.lastSeen)) {
                reputation.lastSeen = receivedAt;
                reputation.lastSite = site;
                reputation.lastStatus = event.status;
                reputation.lastMethod = event.method;
                if (country) {
                    reputation.lastCountry = country;
                }
                reputation.lastGeoProfile = event.geoProfile ?? null;
                reputation.lastGeoFactor = Number.isFinite(event.geoFactor) ? event.geoFactor : 1;
                reputation.lastGeoFallback = Boolean(event.geoFallback);
                reputation.score = Number.isFinite(event.score) ? event.score : 0;
                reputation.level = event.level ?? 'normal';
                reputation.reasons = JSON.stringify(Array.isArray(event.reasons) ? event.reasons : []);
                reputation.scoredAt = receivedAt;
            }
        }
        reputation.count += 1;

        if ((event.level === 'suspect' || event.level === 'critical') && !event.excluded) {
            addScoredZset(
                scoredZsets,
                keys.suspects(),
                ip,
                Number.isFinite(event.score) ? event.score : 0,
                SUSPECTS_TTL_SECONDS
            );
        }

        if (eventStreamEnabled) {
            streams.push({
                key: keys.eventStream(),
                maxlen: eventStreamMaxlen,
                fields: streamFields(event),
            });
        }
    }

    return {
        counters: [...counters.values()],
        zsets: [...zsets.values()].flatMap((entry) => (
            [...entry.members.entries()].map(([member, amount]) => ({
                key: entry.key,
                member,
                amount,
                ttl: entry.ttl,
            }))
        )),
        scoredZsets: [...scoredZsets.values()].flatMap((entry) => (
            [...entry.members.entries()].map(([member, score]) => ({
                key: entry.key,
                member,
                score,
                ttl: entry.ttl,
            }))
        )),
        hashes: [...hashes.values()].flatMap((entry) => (
            [...entry.fields.entries()].map(([field, amount]) => ({
                key: entry.key,
                field,
                amount,
                ttl: entry.ttl,
            }))
        )),
        hlls: [...hlls.values()].map((entry) => ({
            key: entry.key,
            members: [...entry.members],
            ttl: entry.ttl,
        })),
        sets: [...sets.values()].map((entry) => ({
            key: entry.key,
            members: [...entry.members],
            ttl: entry.ttl,
        })),
        reputations: [...reputations.values()],
        streams,
        stats: {
            events: events.length,
            counters: counters.size,
            zsets: zsets.size,
            scoredZsets: scoredZsets.size,
            hashes: hashes.size,
            hlls: hlls.size,
            sets: sets.size,
            reputations: reputations.size,
            streams: streams.length,
        },
    };
}

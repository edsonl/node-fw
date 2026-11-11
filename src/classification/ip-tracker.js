function toMs(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isNaN(parsed) ? Date.now() : parsed;
}

function emptyStats() {
    return {
        count1m: 0,
        count5m: 0,
        count15m: 0,
        site1m: 0,
        site5m: 0,
        site15m: 0,
        burst: 0,
        status5m: {},
        total5m: 0,
        critical1m: 0,
        critical5m: 0,
        distinctSites: 0,
        previousScore: 0,
        previousLevel: 'normal',
    };
}

export function createIpTracker({
    maxTrackedIps = 50000,
    retentionMinutes = 15,
    burstWindowMs = 10000,
    decayPerMinute = 1,
    now = () => Date.now(),
} = {}) {
    const entries = new Map();
    const retentionMs = retentionMinutes * 60 * 1000;

    function prune(entry, nowMs) {
        const currentMinute = Math.floor(nowMs / 60000);
        const cutoff = currentMinute - (retentionMinutes - 1);
        for (const key of entry.buckets.keys()) {
            if (key < cutoff) {
                entry.buckets.delete(key);
            } else {
                break;
            }
        }

        entry.burst = entry.burst.filter((timestamp) => timestamp >= nowMs - burstWindowMs);
        if (entry.burst.length > 5000) {
            entry.burst = entry.burst.slice(-5000);
        }
    }

    function ensureCapacity(nowMs) {
        if (entries.size < maxTrackedIps) {
            return;
        }

        for (const [key, entry] of entries) {
            if (nowMs - entry.lastSeen > retentionMs) {
                entries.delete(key);
            } else {
                break;
            }
        }

        while (entries.size >= maxTrackedIps) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            entries.delete(oldest);
        }
    }

    function getEntry(ip, nowMs) {
        let entry = entries.get(ip);
        if (!entry) {
            ensureCapacity(nowMs);
            entry = {
                buckets: new Map(),
                burst: [],
                firstSeen: nowMs,
                lastSeen: nowMs,
                previousScore: 0,
                previousLevel: 'normal',
                lastScoredAt: null,
            };
            entries.set(ip, entry);
        }
        return entry;
    }

    function record({ ip, site, status, critical = false, at }) {
        const nowMs = toMs(at ?? now());
        const entry = getEntry(ip, nowMs);
        prune(entry, nowMs);

        const minute = Math.floor(nowMs / 60000);
        let bucket = entry.buckets.get(minute);
        if (!bucket) {
            bucket = {
                count: 0,
                sites: new Map(),
                statuses: new Map(),
                criticalHits: 0,
            };
            entry.buckets.set(minute, bucket);
        }

        bucket.count += 1;
        const siteKey = site ?? '';
        bucket.sites.set(siteKey, (bucket.sites.get(siteKey) ?? 0) + 1);
        const statusKey = String(status);
        bucket.statuses.set(statusKey, (bucket.statuses.get(statusKey) ?? 0) + 1);
        if (critical) {
            bucket.criticalHits += 1;
        }

        entry.burst.push(nowMs);
        entry.lastSeen = nowMs;

        return entry;
    }

    function getStats(ip, site, at) {
        const nowMs = toMs(at ?? now());
        const entry = entries.get(ip);
        if (!entry) {
            return emptyStats();
        }

        prune(entry, nowMs);
        const currentMinute = Math.floor(nowMs / 60000);
        const siteKey = site ?? '';
        let count1m = 0;
        let count5m = 0;
        let count15m = 0;
        let site1m = 0;
        let site5m = 0;
        let site15m = 0;
        let critical1m = 0;
        let critical5m = 0;
        const status5m = {};
        const sites15m = new Set();

        for (const [minute, bucket] of entry.buckets) {
            const age = currentMinute - minute;
            if (age < 0 || age > retentionMinutes - 1) {
                continue;
            }

            if (age === 0) {
                count1m += bucket.count;
                site1m += bucket.sites.get(siteKey) ?? 0;
                critical1m += bucket.criticalHits;
            }
            if (age < 5) {
                count5m += bucket.count;
                site5m += bucket.sites.get(siteKey) ?? 0;
                critical5m += bucket.criticalHits;
                for (const [status, count] of bucket.statuses) {
                    status5m[status] = (status5m[status] ?? 0) + count;
                }
            }
            count15m += bucket.count;
            site15m += bucket.sites.get(siteKey) ?? 0;
            for (const siteName of bucket.sites.keys()) {
                sites15m.add(siteName);
            }
        }

        const inactiveMinutes = entry.lastScoredAt === null
            ? 0
            : Math.max(0, Math.floor((nowMs - entry.lastScoredAt) / 60000));
        const decayedScore = Math.max(
            0,
            Math.round(entry.previousScore - inactiveMinutes * decayPerMinute)
        );

        return {
            count1m,
            count5m,
            count15m,
            site1m,
            site5m,
            site15m,
            burst: entry.burst.length,
            status5m,
            total5m: count5m,
            critical1m,
            critical5m,
            distinctSites: sites15m.size,
            previousScore: decayedScore,
            previousLevel: entry.previousLevel,
        };
    }

    function finish(ip, { score, level, at }) {
        const entry = entries.get(ip);
        if (!entry) {
            return;
        }
        entry.previousScore = score;
        entry.previousLevel = level;
        entry.lastScoredAt = toMs(at ?? now());
    }

    function size() {
        return entries.size;
    }

    function clear() {
        entries.clear();
    }

    return {
        record,
        getStats,
        finish,
        size,
        clear,
    };
}

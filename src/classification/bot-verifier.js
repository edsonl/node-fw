import { promises as dnsPromises } from 'node:dns';
import { BlockList, isIP } from 'node:net';

const CLAIMS = [
    {
        name: 'google',
        userAgentPattern: /googlebot/i,
        suffixes: ['.googlebot.com', '.google.com'],
        rangesKey: 'googleRanges',
    },
    {
        name: 'bing',
        userAgentPattern: /bingbot/i,
        suffixes: ['.search.msn.com'],
        rangesKey: 'bingRanges',
    },
];

function normalizeHostname(value) {
    return String(value).toLowerCase().replace(/\.$/, '');
}

function normalizeIp(value) {
    return String(value).toLowerCase();
}

function buildRangeList(cidrs, logger) {
    const list = new BlockList();
    let count = 0;

    for (const cidr of cidrs ?? []) {
        if (typeof cidr !== 'string') {
            continue;
        }
        const [address, prefixText] = cidr.trim().split('/');
        const family = isIP(address);
        const prefix = Number(prefixText);
        if (family === 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
            logger?.warn({ code: 'invalid_bot_range' }, 'ignoring invalid bot CIDR range');
            continue;
        }
        try {
            list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
            count += 1;
        } catch {
            logger?.warn({ code: 'invalid_bot_range' }, 'ignoring invalid bot CIDR range');
        }
    }

    return { list, count };
}

function rangeContains(range, ip) {
    const family = isIP(ip);
    if (family === 0 || range.count === 0) {
        return null;
    }
    try {
        return range.list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
    } catch {
        return null;
    }
}

export function createBotVerifier({
    resolver = dnsPromises,
    ranges = {},
    cacheTtlMs = 86400000,
    maxEntries = 10000,
    now = () => Date.now(),
    logger = null,
} = {}) {
    const cache = new Map();
    const inflight = new Map();
    const rangeLists = {
        google: buildRangeList(ranges.googleRanges, logger),
        bing: buildRangeList(ranges.bingRanges, logger),
    };
    const stats = {
        checks: 0,
        verified: 0,
        failed: 0,
        cacheHits: 0,
        inflight: 0,
        cacheEntries: 0,
        lastError: null,
    };

    function claimsBot(userAgent) {
        if (typeof userAgent !== 'string' || userAgent === '') {
            return null;
        }
        const claim = CLAIMS.find((item) => item.userAgentPattern.test(userAgent));
        return claim?.name ?? null;
    }

    function getCacheEntry(ip) {
        const entry = cache.get(ip);
        if (!entry) {
            return null;
        }
        if (entry.expiresAt <= now()) {
            cache.delete(ip);
            return null;
        }
        return entry;
    }

    function getStatus(ip) {
        return getCacheEntry(ip)?.status ?? null;
    }

    function setCache(ip, claim, result) {
        cache.set(ip, {
            claim,
            status: result.status,
            rangeMatched: result.rangeMatched,
            checkedAt: now(),
            expiresAt: now() + cacheTtlMs,
        });

        while (cache.size > maxEntries) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            cache.delete(oldest);
        }
        stats.cacheEntries = cache.size;
    }

    async function verify(ip, claim) {
        const definition = CLAIMS.find((item) => item.name === claim);
        if (!definition) {
            return { status: 'failed', rangeMatched: null };
        }

        const reversed = await resolver.reverse(ip);
        const hostnames = (Array.isArray(reversed) ? reversed : [reversed])
            .map(normalizeHostname)
            .filter((hostname) => definition.suffixes.some((suffix) => hostname.endsWith(suffix)));

        let dnsVerified = false;
        if (hostnames.length > 0) {
            for (const hostname of hostnames) {
                const addresses = [];
                try {
                    const ipv4 = await resolver.resolve4?.(hostname);
                    if (Array.isArray(ipv4)) {
                        addresses.push(...ipv4);
                    }
                } catch {
                    // Try IPv6 resolution below.
                }
                try {
                    const ipv6 = await resolver.resolve6?.(hostname);
                    if (Array.isArray(ipv6)) {
                        addresses.push(...ipv6);
                    }
                } catch {
                    // The hostname may not have an address of this family.
                }

                if (addresses.map(normalizeIp).includes(normalizeIp(ip))) {
                    dnsVerified = true;
                    break;
                }
            }
        }

        const rangeMatched = rangeContains(rangeLists[claim], ip);
        const verified = dnsVerified && (rangeMatched === null || rangeMatched === true);

        return {
            status: verified ? 'verified' : 'failed',
            rangeMatched,
        };
    }

    function schedule(ip, userAgent) {
        const claim = claimsBot(userAgent);
        if (!claim) {
            return Promise.resolve(null);
        }

        const cached = getCacheEntry(ip);
        if (cached) {
            stats.cacheHits += 1;
            return Promise.resolve(cached.status);
        }
        if (inflight.has(ip)) {
            return inflight.get(ip);
        }

        stats.checks += 1;
        stats.inflight += 1;
        const promise = verify(ip, claim)
            .then((result) => {
                setCache(ip, claim, result);
                if (result.status === 'verified') {
                    stats.verified += 1;
                } else {
                    stats.failed += 1;
                }
                return result.status;
            })
            .catch((error) => {
                stats.failed += 1;
                stats.lastError = { code: error?.code ?? 'dns_error', at: new Date().toISOString() };
                logger?.debug({ claim, code: stats.lastError.code }, 'bot verification failed');
                setCache(ip, claim, { status: 'failed', rangeMatched: null });
                return 'failed';
            })
            .finally(() => {
                stats.inflight = Math.max(0, stats.inflight - 1);
                inflight.delete(ip);
            });

        inflight.set(ip, promise);
        return promise;
    }

    function getStats() {
        return {
            ...stats,
            cacheEntries: cache.size,
        };
    }

    function close() {
        cache.clear();
        inflight.clear();
        stats.cacheEntries = 0;
    }

    return {
        claimsBot,
        getStatus,
        schedule,
        getStats,
        close,
    };
}

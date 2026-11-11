import { BlockList, isIP } from 'node:net';

import { createIpTracker } from './ip-tracker.js';
import { GEO_PROFILE_PRECEDENCE } from './rules.js';

function buildCidrList(cidrs, logger) {
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
            if (logger) {
                logger.warn({ code: 'invalid_exception_cidr' }, 'ignoring invalid exception CIDR');
            }
            continue;
        }
        try {
            list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
            count += 1;
        } catch {
            if (logger) {
                logger.warn({ code: 'invalid_exception_cidr' }, 'ignoring invalid exception CIDR');
            }
        }
    }

    return { list, count };
}

function cidrMatches(range, ip) {
    const family = isIP(ip);
    if (family === 0 || range.count === 0) {
        return false;
    }
    try {
        return range.list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
    } catch {
        return false;
    }
}

function pathMatches(path, prefixes) {
    if (typeof path !== 'string' || path === '') {
        return false;
    }
    return prefixes.some((prefix) => (
        path === prefix
        || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
    ));
}

function prepareGeoCountryMap(geoProfiles) {
    const map = new Map();
    if (!geoProfiles.enabled) {
        return map;
    }

    for (const profile of GEO_PROFILE_PRECEDENCE) {
        for (const country of geoProfiles.countries[profile]) {
            if (!map.has(country)) {
                map.set(country, profile);
            }
        }
    }

    return map;
}

function prepareRules(rules, logger) {
    return {
        ...rules,
        preparedCidrs: buildCidrList(rules.exceptions.cidrs, logger),
        preparedIps: new Set(rules.exceptions.ips),
        preparedAsns: new Set(rules.exceptions.asns),
        preparedPaths: [...rules.exceptions.paths],
        preparedCriticalPaths: [...rules.criticalPaths],
        preparedAuthPaths: [...rules.authPaths],
        preparedGeoCountries: prepareGeoCountryMap(rules.geoProfiles),
    };
}

function normalizeCountryCode(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const code = value.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : null;
}

function resolveGeoProfile(rules, country) {
    if (!rules.geoProfiles.enabled) {
        return { profile: null, factor: 1, fallback: false };
    }

    const code = normalizeCountryCode(country);
    const matched = code ? rules.preparedGeoCountries.get(code) : null;
    const profile = matched ?? rules.geoProfiles.unknownProfile;

    return {
        profile,
        factor: rules.geoProfiles.profiles[profile].rateFactor,
        fallback: !matched,
    };
}

function formatLimit(value) {
    return Number.isInteger(value)
        ? String(value)
        : String(Math.round(value * 100) / 100);
}

function levelForScore(score, thresholds) {
    if (score >= thresholds.critical) {
        return 'critical';
    }
    if (score >= thresholds.suspect) {
        return 'suspect';
    }
    if (score >= thresholds.observation) {
        return 'observation';
    }
    return 'normal';
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function createClassifier({
    rules,
    rulesSource = 'default',
    rulesError = null,
    botVerifier = null,
    logger = null,
    now = () => Date.now(),
} = {}) {
    if (!rules) {
        throw new Error('Classification rules are required');
    }

    const globalRules = prepareRules(rules, logger);
    const siteRules = new Map();
    for (const [site, siteRuleSet] of Object.entries(rules.sites ?? {})) {
        siteRules.set(site, prepareRules(siteRuleSet, logger));
    }

    const tracker = createIpTracker({
        maxTrackedIps: rules.state.maxTrackedIps,
        decayPerMinute: rules.state.decayPerMinute,
        now,
    });

    const stats = {
        decisions: 0,
        levelCounts: {
            normal: 0,
            observation: 0,
            suspect: 0,
            critical: 0,
        },
        hardExceptions: 0,
        pathExceptions: 0,
        errors: 0,
        modeCounts: { 1: 0, 2: 0, 3: 0 },
        geoProfileCounts: { relaxed: 0, standard: 0, strict: 0 },
        lastError: null,
    };

    function rulesForSite(site) {
        return siteRules.get(String(site).toLowerCase()) ?? globalRules;
    }

    function hardException(siteRulesValue, event, botStatus) {
        if (siteRulesValue.preparedIps.has(event.ip)) {
            return 'exception_ip';
        }
        if (cidrMatches(siteRulesValue.preparedCidrs, event.ip)) {
            return 'exception_cidr';
        }
        if (event.asn && siteRulesValue.preparedAsns.has(event.asn)) {
            return 'exception_asn';
        }
        if (siteRulesValue.exceptions.verifiedBots && botStatus === 'verified') {
            return 'exception_verified_bot';
        }
        return null;
    }

    function classify(event) {
        const mode = Number(event.mode ?? globalRules.mode);
        event.score = 0;
        event.level = 'normal';
        event.reasons = [];
        event.mode = Number.isInteger(mode) && [1, 2, 3].includes(mode) ? mode : globalRules.mode;
        event.blockEligible = false;
        event.excluded = false;
        event.geoProfile = null;
        event.geoFactor = 1;
        event.geoFallback = false;

        try {
            const activeRules = rulesForSite(event.site);
            event.mode = activeRules.mode;
            const geo = resolveGeoProfile(activeRules, event.country);
            event.geoProfile = geo.profile;
            event.geoFactor = geo.factor;
            event.geoFallback = geo.fallback;
            if (geo.profile) {
                stats.geoProfileCounts[geo.profile] += 1;
            }
            const nowMs = Date.parse(event.receivedAt) || now();
            const claim = botVerifier?.claimsBot(event.userAgent) ?? null;
            const botStatus = claim && botVerifier ? botVerifier.getStatus(event.ip) : null;

            if (claim && botVerifier && !botStatus) {
                Promise.resolve(botVerifier.schedule(event.ip, event.userAgent)).catch(() => {});
            }

            const pathException = pathMatches(event.path, activeRules.preparedPaths);
            if (pathException) {
                stats.pathExceptions += 1;
            }
            const criticalPath = !pathException && pathMatches(event.path, activeRules.preparedCriticalPaths);

            tracker.record({
                ip: event.ip,
                site: event.site,
                status: event.status,
                critical: criticalPath,
                at: nowMs,
            });
            const ipStats = tracker.getStats(event.ip, event.site, nowMs);

            const exception = pathException
                ? 'exception_path'
                : hardException(activeRules, event, botStatus);
            if (exception) {
                stats.hardExceptions += 1;
                event.reasons = [exception];
                event.excluded = true;
                event.score = 0;
                event.level = 'normal';
                tracker.finish(event.ip, { score: 0, level: 'normal', at: nowMs });
                stats.decisions += 1;
                stats.levelCounts.normal += 1;
                stats.modeCounts[event.mode] += 1;
                return event;
            }

            const reasons = [];
            let score = 0;
            const add = (weight, reason) => {
                if (!Number.isFinite(weight) || weight === 0) {
                    return;
                }
                score += weight;
                reasons.push(reason);
            };

            const country = typeof event.country === 'string' ? event.country.toUpperCase() : null;
            if (country) {
                if (!activeRules.countries.home.includes(country)) {
                    add(activeRules.weights.foreignCountry, `foreign_country:${country}`);
                }
                if (activeRules.countries.monitored.includes(country)) {
                    add(activeRules.weights.monitoredCountry, `monitored_country:${country}`);
                }
            }

            if (event.asn && activeRules.hostingAsns.includes(event.asn)) {
                add(activeRules.weights.hostingAsn, `hosting_asn:${event.asn}`);
            } else if (event.asnOrg) {
                const organization = event.asnOrg.toLowerCase();
                if (activeRules.hostingOrgPatterns.some((pattern) => organization.includes(pattern.toLowerCase()))) {
                    add(activeRules.weights.hostingAsn, 'hosting_org');
                }
            }

            const botRateMultiplier = botStatus === 'verified'
                ? activeRules.botVerification.rateMultiplier
                : 1;
            const geoRateMultiplier = geo.factor;
            const limit1m = activeRules.rateLimits.perMinute * geoRateMultiplier * botRateMultiplier;
            if (ipStats.site1m > limit1m * 10) {
                add(activeRules.weights.rate10x, `rate_1m:${ipStats.site1m}/${formatLimit(limit1m)}`);
            } else if (ipStats.site1m > limit1m * 3) {
                add(activeRules.weights.rate3x, `rate_1m:${ipStats.site1m}/${formatLimit(limit1m)}`);
            } else if (ipStats.site1m > limit1m) {
                add(activeRules.weights.rateAboveLimit, `rate_1m:${ipStats.site1m}/${formatLimit(limit1m)}`);
            }

            const limit5m = activeRules.rateLimits.per5m * geoRateMultiplier * botRateMultiplier;
            if (ipStats.site5m > limit5m) {
                add(activeRules.weights.rate5m, `rate_5m:${ipStats.site5m}/${formatLimit(limit5m)}`);
            }
            const limit15m = activeRules.rateLimits.per15m * geoRateMultiplier * botRateMultiplier;
            if (ipStats.site15m > limit15m) {
                add(activeRules.weights.rate15m, `rate_15m:${ipStats.site15m}/${formatLimit(limit15m)}`);
            }
            const burstLimit = activeRules.rateLimits.burst10s * geoRateMultiplier * botRateMultiplier;
            if (ipStats.burst > burstLimit) {
                add(activeRules.weights.burst, `burst_10s:${ipStats.burst}/${formatLimit(burstLimit)}`);
            }
            const criticalPathLimit = activeRules.rateLimits.criticalPathPerMinute * botRateMultiplier;
            if (ipStats.critical1m > criticalPathLimit) {
                add(
                    activeRules.weights.criticalPathRate,
                    `critical_path_rate:${ipStats.critical1m}/${formatLimit(criticalPathLimit)}`
                );
            }

            const total5m = ipStats.total5m;
            const notFound = Number(ipStats.status5m['404'] ?? 0);
            if (total5m >= 20 && notFound / total5m >= 0.7) {
                add(activeRules.weights.notFoundRatio, `not_found_ratio:${notFound}/${total5m}`);
            }
            const denied = Number(ipStats.status5m['403'] ?? 0) + Number(ipStats.status5m['429'] ?? 0);
            if (total5m >= 10 && denied / total5m >= 0.5) {
                add(activeRules.weights.deniedRatio, `denied_ratio:${denied}/${total5m}`);
            }

            if (ipStats.critical5m > 0) {
                add(
                    Math.min(activeRules.weights.criticalPath, activeRules.weights.criticalPathCap),
                    `critical_path:${ipStats.critical5m}`
                );
            }

            if (!event.userAgent) {
                add(activeRules.weights.emptyUserAgent, 'empty_user_agent');
            }
            if (event.method === 'POST' && pathMatches(event.path, activeRules.preparedAuthPaths)) {
                add(activeRules.weights.authPost, `auth_post:${event.path.slice(0, 128)}`);
            }

            if (claim && botStatus === 'verified') {
                add(activeRules.weights.verifiedBot, `verified_bot:${claim}`);
            } else if (claim && botStatus === 'failed') {
                add(activeRules.weights.botClaimUnverified, `bot_claim_unverified:${claim}`);
            } else if (claim) {
                add(activeRules.weights.botClaimPending, `bot_claim_pending:${claim}`);
            }

            if (ipStats.previousScore >= activeRules.thresholds.critical) {
                add(activeRules.weights.reincidence, `reincidence:${ipStats.previousScore}`);
            }
            if (ipStats.distinctSites >= activeRules.multiSiteThreshold) {
                add(activeRules.weights.multiSite, `multi_site:${ipStats.distinctSites}`);
            }

            event.score = Math.round(clamp(score, 0, 100));
            event.level = levelForScore(event.score, activeRules.thresholds);
            event.reasons = reasons;
            const positiveSignals = reasons.filter((reason) => (
                !reason.startsWith('verified_bot:')
                && !reason.startsWith('exception_')
            )).length;
            event.blockEligible = event.mode === 3
                && event.score >= activeRules.thresholds.block
                && positiveSignals >= activeRules.minimumSignalsForBlock
                && botStatus !== 'verified';

            tracker.finish(event.ip, {
                score: event.score,
                level: event.level,
                at: nowMs,
            });

            stats.decisions += 1;
            stats.levelCounts[event.level] += 1;
            stats.modeCounts[event.mode] += 1;
            return event;
        } catch (error) {
            stats.errors += 1;
            stats.lastError = { code: error?.code ?? 'classifier_error', at: new Date().toISOString() };
            event.score = 0;
            event.level = 'normal';
            event.reasons = ['classifier_error'];
            event.blockEligible = false;
            logger?.warn({ code: stats.lastError.code }, 'classification failed');
            return event;
        }
    }

    function getStats() {
        return {
            ...stats,
            levelCounts: { ...stats.levelCounts },
            modeCounts: { ...stats.modeCounts },
            geoProfileCounts: { ...stats.geoProfileCounts },
            trackedIps: tracker.size(),
            rulesSource,
            rulesError,
            botVerifier: botVerifier?.getStats?.() ?? null,
        };
    }

    function close() {
        botVerifier?.close?.();
        tracker.clear();
    }

    return {
        classify,
        getStats,
        close,
    };
}

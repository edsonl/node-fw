const PREFIX_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export function createKeyBuilder(prefix) {
    if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix)) {
        throw new TypeError('Redis prefix has an invalid format');
    }

    const base = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
    const key = (...parts) => [base, ...parts].join(':');

    return Object.freeze({
        base,
        globalRate: (window, bucket) => key('rate', 'g', window, bucket),
        siteRate: (site, window, bucket) => key('rate', 'site', site, window, bucket),
        ipRate: (ip, window, bucket) => key('rate', 'ip', ip, window, bucket),
        ipSiteRate: (ip, site, window, bucket) => key('rate', 'ip_site', ip, site, window, bucket),
        globalUnique: (window, bucket) => key('uniq', 'g', window, bucket),
        siteUnique: (site, window, bucket) => key('uniq', 'site', site, window, bucket),
        globalCountry: (window, bucket) => key('country', 'g', window, bucket),
        siteCountry: (site, window, bucket) => key('country', 'site', site, window, bucket),
        globalStatus: (window, bucket) => key('status', 'g', window, bucket),
        siteStatus: (site, window, bucket) => key('status', 'site', site, window, bucket),
        globalDynamic: (window, bucket) => key('dynamic', 'g', window, bucket),
        siteDynamic: (site, window, bucket) => key('dynamic', 'site', site, window, bucket),
        globalIpRank: (window, bucket) => key('rank', 'ip', 'g', window, bucket),
        siteIpRank: (site, window, bucket) => key('rank', 'ip', 'site', site, window, bucket),
        ipSites: (ip) => key('ip', ip, 'sites'),
        reputation: (ip) => key('score', 'ip', ip),
        eventStream: () => key('events'),
    });
}

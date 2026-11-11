import assert from 'node:assert/strict';
import test from 'node:test';

import { createBotVerifier } from '../src/classification/bot-verifier.js';

function resolver({ reverse = {}, forward = {} } = {}) {
    return {
        async reverse(ip) {
            if (reverse[ip] instanceof Error) {
                throw reverse[ip];
            }
            return reverse[ip] ?? [];
        },
        async resolve4(hostname) {
            if (forward[hostname]?.error) {
                throw forward[hostname].error;
            }
            return forward[hostname]?.ipv4 ?? [];
        },
        async resolve6(hostname) {
            if (forward[hostname]?.error) {
                throw forward[hostname].error;
            }
            return forward[hostname]?.ipv6 ?? [];
        },
    };
}

test('verifies Googlebot by reverse and forward DNS', async () => {
    const verifier = createBotVerifier({
        resolver: resolver({
            reverse: { '66.249.66.1': ['crawl-66-249-66-1.googlebot.com.'] },
            forward: { 'crawl-66-249-66-1.googlebot.com': { ipv4: ['66.249.66.1'] } },
        }),
    });

    assert.equal(verifier.claimsBot('Mozilla/5.0 (compatible; Googlebot/2.1)'), 'google');
    assert.equal(verifier.getStatus('66.249.66.1'), null);
    assert.equal(await verifier.schedule('66.249.66.1', 'Googlebot/2.1'), 'verified');
    assert.equal(verifier.getStatus('66.249.66.1'), 'verified');
    assert.equal(verifier.getStats().verified, 1);
});

test('verifies Bingbot over IPv6', async () => {
    const ip = '2001:db8::1234';
    const hostname = 'msnbot-2001-db8--1234.search.msn.com';
    const verifier = createBotVerifier({
        resolver: resolver({
            reverse: { [ip]: [hostname] },
            forward: { [hostname]: { ipv6: [ip] } },
        }),
    });

    assert.equal(verifier.claimsBot('Mozilla/5.0 (compatible; bingbot/2.0)'), 'bing');
    assert.equal(await verifier.schedule(ip, 'bingbot/2.0'), 'verified');
});

test('fails claims with mismatched forward DNS or no bot claim', async () => {
    const verifier = createBotVerifier({
        resolver: resolver({
            reverse: { '66.249.66.1': ['crawl-66-249-66-1.googlebot.com'] },
            forward: { 'crawl-66-249-66-1.googlebot.com': { ipv4: ['8.8.8.8'] } },
        }),
    });

    assert.equal(await verifier.schedule('66.249.66.1', 'Googlebot/2.1'), 'failed');
    assert.equal(verifier.getStatus('66.249.66.1'), 'failed');
    assert.equal(verifier.claimsBot('curl/8.0'), null);
    assert.equal(await verifier.schedule('8.8.8.8', 'curl/8.0'), null);
});

test('uses configured published ranges when present', async () => {
    const verified = createBotVerifier({
        resolver: resolver({
            reverse: { '66.249.66.1': ['crawl-66-249-66-1.googlebot.com'] },
            forward: { 'crawl-66-249-66-1.googlebot.com': { ipv4: ['66.249.66.1'] } },
        }),
        ranges: { googleRanges: ['66.249.64.0/19'] },
    });
    assert.equal(await verified.schedule('66.249.66.1', 'Googlebot/2.1'), 'verified');

    const outside = createBotVerifier({
        resolver: resolver({
            reverse: { '66.249.66.1': ['crawl-66-249-66-1.googlebot.com'] },
            forward: { 'crawl-66-249-66-1.googlebot.com': { ipv4: ['66.249.66.1'] } },
        }),
        ranges: { googleRanges: ['8.8.8.0/24'] },
    });
    assert.equal(await outside.schedule('66.249.66.1', 'Googlebot/2.1'), 'failed');
});

test('caches verification results and handles DNS errors safely', async () => {
    let reverseCalls = 0;
    const verifier = createBotVerifier({
        resolver: {
            async reverse() {
                reverseCalls += 1;
                throw new Error('dns failure');
            },
            async resolve4() {
                return [];
            },
            async resolve6() {
                return [];
            },
        },
    });

    assert.equal(await verifier.schedule('66.249.66.1', 'Googlebot/2.1'), 'failed');
    assert.equal(await verifier.schedule('66.249.66.1', 'Googlebot/2.1'), 'failed');
    assert.equal(reverseCalls, 1);
    assert.equal(verifier.getStats().cacheHits, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { EventValidationError, parseSecurityEvent } from '../src/collector/event-parser.js';

function baseEvent(overrides = {}) {
    return {
        timestamp: '2026-11-05T13:45:00-03:00',
        site: 'WWW.Example.com.',
        ip: '203.0.113.10',
        method: 'GET',
        path: '/catalogsearch/result?q=secret',
        final_uri: '/index.php',
        status: 200,
        request_time: 0.123,
        upstream_addr: 'unix:/run/php/php8.2-fpm.sock',
        upstream_time: '0.100',
        dynamic: 1,
        scheme: 'https',
        body_bytes_sent: 1234,
        user_agent: 'Mozilla/5.0',
        request_id: 'abc12345',
        server_name: 'www.example.com',
        ...overrides,
    };
}

function parse(overrides = {}, options = {}) {
    return parseSecurityEvent(JSON.stringify(baseEvent(overrides)), options);
}

function assertReason(fn, reason) {
    assert.throws(fn, (error) => error instanceof EventValidationError && error.reason === reason);
}

test('normalizes a valid event and removes the query string', () => {
    const parsed = parse({}, { receivedAt: new Date('2026-11-05T16:45:00.123Z') });

    assert.equal(parsed.eventVersion, 1);
    assert.equal(parsed.site, 'www.example.com');
    assert.equal(parsed.path, '/catalogsearch/result');
    assert.equal(parsed.finalUri, '/index.php');
    assert.equal(parsed.ip, '203.0.113.10');
    assert.equal(parsed.ipScope, 'documentation');
    assert.equal(parsed.dynamic, true);
    assert.equal(parsed.requestTime, 0.123);
    assert.equal(parsed.upstreamTime, '0.100');
    assert.equal(parsed.userAgent, 'Mozilla/5.0');
    assert.equal(parsed.userAgentTruncated, false);
    assert.equal(parsed.receivedAt, '2026-11-05T16:45:00.123Z');
});

test('infers dynamic from upstream address', () => {
    assert.equal(parse({ dynamic: undefined }).dynamic, true);
    assert.equal(parse({ dynamic: undefined, upstream_addr: '-' }).dynamic, false);
});

test('accepts IPv6 site literals and multiple upstream times', () => {
    const parsed = parse({
        site: '[2001:db8::1]',
        upstream_time: '0.100, 0.200',
    });

    assert.equal(parsed.site, '2001:db8::1');
    assert.equal(parsed.upstreamTime, '0.100, 0.200');
});

test('normalizes empty and dash upstream values', () => {
    const parsed = parse({ upstream_addr: '-', upstream_time: '-' });

    assert.equal(parsed.upstreamAddress, null);
    assert.equal(parsed.upstreamTime, null);
    assert.equal(parsed.dynamic, true);
});

test('truncates and sanitizes the User-Agent', () => {
    const truncated = parse({ user_agent: '123456789012345' }, { userAgentMaxLength: 10 });
    assert.equal(truncated.userAgent, '1234567890');
    assert.equal(truncated.userAgentTruncated, true);

    const sanitized = parse({ user_agent: 'abc\n def' });
    assert.equal(sanitized.userAgent, 'abc  def');
});

test('ignores unknown fields and does not pollute prototypes', () => {
    const raw = `${JSON.stringify(baseEvent()).slice(0, -1)},"__proto__":{"polluted":true}}`;
    const parsed = parseSecurityEvent(raw);

    assert.equal(parsed.polluted, undefined);
    assert.equal({}.polluted, undefined);
    assert.equal('extra' in parsed, false);
});

test('rejects invalid JSON and non-object events', () => {
    assertReason(() => parseSecurityEvent('{'), 'invalid_json');
    assertReason(() => parseSecurityEvent('[]'), 'invalid_event');
    assertReason(() => parseSecurityEvent('   '), 'empty_event');
});

test('rejects invalid core fields', () => {
    assertReason(() => parse({ timestamp: 'not-a-date' }), 'invalid_timestamp');
    assertReason(() => parse({ ip: '999.1.1.1' }), 'invalid_ip');
    assertReason(() => parse({ site: 'bad_site' }), 'invalid_site');
    assertReason(() => parse({ method: 'get' }), 'invalid_method');
    assertReason(() => parse({ path: 'relative/path' }), 'invalid_path');
    assertReason(() => parse({ path: '?only=query' }), 'invalid_path');
    assertReason(() => parse({ path: '/bad\npath' }), 'invalid_characters');
    assertReason(() => parse({ status: 99 }), 'invalid_integer');
    assertReason(() => parse({ request_time: -1 }), 'invalid_number');
    assertReason(() => parse({ body_bytes_sent: -1 }), 'invalid_integer');
    assertReason(() => parse({ upstream_time: 'abc' }), 'invalid_upstream_time');
    assertReason(() => parse({ request_id: 'bad id' }), 'invalid_request_id');
    assertReason(() => parse({ dynamic: 'yes' }), 'invalid_boolean');
});

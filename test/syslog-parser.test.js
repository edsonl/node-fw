import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSyslogMessage, SyslogParseError } from '../src/collector/syslog-parser.js';

function assertParseReason(fn, reason) {
    assert.throws(fn, (error) => error instanceof SyslogParseError && error.reason === reason);
}

test('parses syslog with priority, timestamp, hostname and tag', () => {
    const parsed = parseSyslogMessage(
        '<134>Nov  5 13:45:00 web01 nodefw: {"timestamp":"2026-11-05T13:45:00-03:00"}',
        { tag: 'nodefw' }
    );

    assert.equal(parsed.priority, 134);
    assert.equal(parsed.facility, 16);
    assert.equal(parsed.severity, 6);
    assert.equal(parsed.timestamp, 'Nov  5 13:45:00');
    assert.equal(parsed.hostname, 'web01');
    assert.equal(parsed.tag, 'nodefw');
    assert.equal(parsed.message, '{"timestamp":"2026-11-05T13:45:00-03:00"}');
});

test('parses syslog without hostname', () => {
    const parsed = parseSyslogMessage('<134>Nov  5 13:45:00 nodefw: {"a":1}', { tag: 'nodefw' });

    assert.equal(parsed.hostname, null);
    assert.equal(parsed.tag, 'nodefw');
    assert.equal(parsed.message, '{"a":1}');
});

test('parses syslog without priority and timestamp', () => {
    const parsed = parseSyslogMessage('nodefw: {"a":1}', { tag: 'nodefw' });

    assert.equal(parsed.priority, null);
    assert.equal(parsed.facility, null);
    assert.equal(parsed.severity, null);
    assert.equal(parsed.timestamp, null);
    assert.equal(parsed.message, '{"a":1}');
});

test('keeps JSON content with colons and spaces', () => {
    const parsed = parseSyslogMessage('nodefw: {"url":"https://example.com/a b"}', { tag: 'nodefw' });

    assert.equal(parsed.message, '{"url":"https://example.com/a b"}');
});

test('accepts tags with dots and hyphens', () => {
    const parsed = parseSyslogMessage('nodefw.security-1: payload', { tag: 'nodefw.security-1' });

    assert.equal(parsed.tag, 'nodefw.security-1');
    assert.equal(parsed.message, 'payload');
});

test('rejects an unexpected tag', () => {
    assertParseReason(
        () => parseSyslogMessage('<134>Nov  5 13:45:00 other: {"a":1}', { tag: 'nodefw' }),
        'unexpected_tag'
    );
});

test('rejects invalid priorities', () => {
    assertParseReason(() => parseSyslogMessage('<200>Nov  5 13:45:00 nodefw: x'), 'invalid_priority');
});

test('rejects malformed messages and empty payloads', () => {
    assertParseReason(() => parseSyslogMessage('nodefw'), 'malformed_syslog');
    assertParseReason(() => parseSyslogMessage('nodefw:   '), 'empty_message');
    assertParseReason(() => parseSyslogMessage(''), 'empty_message');
    assertParseReason(() => parseSyslogMessage(null), 'invalid_input');
});

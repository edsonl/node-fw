import { isIP } from 'node:net';

import { getIpScope } from '../utils/ip.js';

const MAX_HOSTNAME_LENGTH = 253;
const MAX_PATH_LENGTH = 2048;
const MAX_HEADER_VALUE_LENGTH = 512;
const MAX_UPSTREAM_TIME_LENGTH = 512;
const MAX_METHOD_LENGTH = 16;
const MAX_REQUEST_ID_LENGTH = 64;

const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;
const HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const METHOD_PATTERN = /^[A-Z][A-Z0-9_-]{0,15}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UPSTREAM_TIME_PATTERN = /^\d+(?:\.\d+)?(?:,\s*\d+(?:\.\d+)?)*$/;

export class EventValidationError extends Error {
    constructor(reason, field, message) {
        super(message);
        this.name = 'EventValidationError';
        this.code = 'EVENT_VALIDATION_ERROR';
        this.reason = reason;
        this.field = field;
    }
}

function fail(reason, field, message) {
    throw new EventValidationError(reason, field, message);
}

function requireString(value, field, maxLength) {
    if (typeof value !== 'string') {
        fail('invalid_type', field, `${field} must be a string`);
    }

    const trimmed = value.trim();
    if (trimmed === '') {
        fail('empty_field', field, `${field} must not be empty`);
    }
    if (trimmed.length > maxLength) {
        fail('too_long', field, `${field} exceeds the maximum length`);
    }

    return trimmed;
}

function optionalText(value, field, maxLength) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        fail('invalid_type', field, `${field} must be a string`);
    }

    const trimmed = value.trim();
    if (trimmed === '') {
        return null;
    }
    if (trimmed.length > maxLength) {
        fail('too_long', field, `${field} exceeds the maximum length`);
    }
    if (CONTROL_CHAR_PATTERN.test(trimmed)) {
        fail('invalid_characters', field, `${field} contains control characters`);
    }

    return trimmed;
}

function toInteger(value, field, min, max) {
    let number = value;
    if (typeof number === 'string' && /^-?\d+$/.test(number.trim())) {
        number = Number(number.trim());
    }

    if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
        fail('invalid_integer', field, `${field} must be an integer between ${min} and ${max}`);
    }

    return number;
}

function toNumber(value, field, min, max) {
    let number = value;
    if (typeof number === 'string' && /^-?\d+(?:\.\d+)?$/.test(number.trim())) {
        number = Number(number.trim());
    }

    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) {
        fail('invalid_number', field, `${field} must be a number between ${min} and ${max}`);
    }

    return number;
}

function normalizeSite(value) {
    let site = requireString(value, 'site', MAX_HOSTNAME_LENGTH + 2).toLowerCase();

    if (site.endsWith('.')) {
        site = site.slice(0, -1);
    }
    if (site.startsWith('[') && site.endsWith(']')) {
        site = site.slice(1, -1);
    }

    if (isIP(site) !== 0) {
        return site;
    }

    if (site === '' || site.length > MAX_HOSTNAME_LENGTH || !HOSTNAME_PATTERN.test(site)) {
        fail('invalid_site', 'site', 'site must be a valid hostname or IP address');
    }

    return site;
}

function normalizePath(value, field) {
    let path = requireString(value, field, 8192);

    const queryIndex = path.indexOf('?');
    if (queryIndex !== -1) {
        path = path.slice(0, queryIndex);
    }

    if (path === '' || path.length > MAX_PATH_LENGTH) {
        fail('invalid_path', field, `${field} has an invalid length`);
    }
    if (!path.startsWith('/')) {
        fail('invalid_path', field, `${field} must start with /`);
    }
    if (CONTROL_CHAR_PATTERN.test(path)) {
        fail('invalid_characters', field, `${field} contains control characters`);
    }

    return path;
}

function normalizeUpstreamAddress(value) {
    const text = optionalText(value, 'upstream_addr', MAX_HEADER_VALUE_LENGTH);
    return text === '-' ? null : text;
}

function normalizeUpstreamTime(value) {
    if (value === undefined || value === null) {
        return null;
    }

    let text;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        text = String(value);
    } else if (typeof value === 'string') {
        text = value.trim();
    } else {
        fail('invalid_upstream_time', 'upstream_time', 'upstream_time must be a string or non-negative number');
    }

    if (text === '' || text === '-') {
        return null;
    }
    if (text.length > MAX_UPSTREAM_TIME_LENGTH || !UPSTREAM_TIME_PATTERN.test(text)) {
        fail('invalid_upstream_time', 'upstream_time', 'upstream_time has an invalid format');
    }

    return text;
}

function normalizeDynamic(value, upstreamAddress) {
    if (value === undefined || value === null) {
        return upstreamAddress !== null;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (value === 0 || value === 1) {
        return value === 1;
    }
    if (value === '0' || value === '1') {
        return value === '1';
    }

    fail('invalid_boolean', 'dynamic', 'dynamic must be a boolean or 0/1');
}

function normalizeScheme(value) {
    const text = optionalText(value, 'scheme', 16);
    if (text === null) {
        return null;
    }

    const scheme = text.toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
        fail('invalid_scheme', 'scheme', 'scheme must be http or https');
    }

    return scheme;
}

function normalizeRequestId(value) {
    const text = optionalText(value, 'request_id', MAX_REQUEST_ID_LENGTH);
    if (text === null) {
        return null;
    }
    if (!REQUEST_ID_PATTERN.test(text)) {
        fail('invalid_request_id', 'request_id', 'request_id has an invalid format');
    }

    return text;
}

function sanitizeUserAgent(value, maxLength) {
    const original = typeof value === 'string' ? value : '';
    const clean = original
        .replace(/[\u0000-\u001F\u007F]+/g, ' ')
        .trim();

    return {
        userAgent: clean.slice(0, maxLength),
        userAgentTruncated: clean.length > maxLength,
    };
}

export function parseSecurityEvent(rawMessage, options = {}) {
    if (typeof rawMessage !== 'string' || rawMessage.trim() === '') {
        fail('empty_event', 'message', 'Event message must be a non-empty string');
    }

    let parsed;
    try {
        parsed = JSON.parse(rawMessage);
    } catch {
        fail('invalid_json', 'message', 'Event is not valid JSON');
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('invalid_event', 'message', 'Event must be a JSON object');
    }

    const timestamp = requireString(parsed.timestamp, 'timestamp', 64);
    if (Number.isNaN(Date.parse(timestamp))) {
        fail('invalid_timestamp', 'timestamp', 'timestamp is not a valid date');
    }

    const site = normalizeSite(parsed.site);
    const ip = requireString(parsed.ip, 'ip', 64);
    const ipScope = getIpScope(ip);
    if (ipScope === 'invalid') {
        fail('invalid_ip', 'ip', 'ip is not a valid IPv4 or IPv6 address');
    }

    const method = requireString(parsed.method, 'method', MAX_METHOD_LENGTH);
    if (!METHOD_PATTERN.test(method)) {
        fail('invalid_method', 'method', 'method has an invalid format');
    }

    const path = normalizePath(parsed.path, 'path');
    const finalUri = parsed.final_uri === undefined || parsed.final_uri === null || parsed.final_uri === ''
        ? null
        : normalizePath(parsed.final_uri, 'final_uri');

    const status = toInteger(parsed.status, 'status', 100, 599);
    const requestTime = toNumber(parsed.request_time, 'request_time', 0, 86400);
    const upstreamAddress = normalizeUpstreamAddress(parsed.upstream_addr);
    const upstreamTime = normalizeUpstreamTime(parsed.upstream_time);
    const dynamic = normalizeDynamic(parsed.dynamic, upstreamAddress);
    const scheme = normalizeScheme(parsed.scheme);
    const bodyBytesSent = parsed.body_bytes_sent === undefined
        ? 0
        : toInteger(parsed.body_bytes_sent, 'body_bytes_sent', 0, 1_000_000_000_000);
    const requestId = normalizeRequestId(parsed.request_id);
    const serverName = optionalText(parsed.server_name, 'server_name', MAX_HOSTNAME_LENGTH);
    const userAgentMaxLength = options.userAgentMaxLength ?? 512;
    const { userAgent, userAgentTruncated } = sanitizeUserAgent(parsed.user_agent, userAgentMaxLength);

    const receivedAt = options.receivedAt instanceof Date && !Number.isNaN(options.receivedAt.getTime())
        ? options.receivedAt.toISOString()
        : new Date().toISOString();

    return {
        eventVersion: 1,
        timestamp,
        receivedAt,
        requestId,
        site,
        serverName,
        ip,
        ipScope,
        method,
        path,
        finalUri,
        status,
        requestTime,
        upstreamAddress,
        upstreamTime,
        dynamic,
        scheme,
        bodyBytesSent,
        userAgent,
        userAgentTruncated,
    };
}

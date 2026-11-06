import assert from 'node:assert/strict';
import test from 'node:test';

import { getIpScope, isLoopbackIp, isPrivateOrLocalIp } from '../src/utils/ip.js';

test('classifies IPv4 scopes', () => {
    assert.equal(getIpScope('127.0.0.1'), 'loopback');
    assert.equal(getIpScope('10.0.0.1'), 'private');
    assert.equal(getIpScope('172.16.0.1'), 'private');
    assert.equal(getIpScope('172.32.0.1'), 'public');
    assert.equal(getIpScope('192.168.1.1'), 'private');
    assert.equal(getIpScope('169.254.1.1'), 'linkLocal');
    assert.equal(getIpScope('100.64.0.1'), 'shared');
    assert.equal(getIpScope('203.0.113.10'), 'documentation');
    assert.equal(getIpScope('8.8.8.8'), 'public');
    assert.equal(getIpScope('0.0.0.0'), 'unspecified');
    assert.equal(getIpScope('224.0.0.1'), 'multicast');
    assert.equal(getIpScope('255.255.255.255'), 'reserved');
});

test('classifies IPv6 scopes', () => {
    assert.equal(getIpScope('::1'), 'loopback');
    assert.equal(getIpScope('fe80::1'), 'linkLocal');
    assert.equal(getIpScope('fc00::1'), 'private');
    assert.equal(getIpScope('2001:db8::1'), 'documentation');
    assert.equal(getIpScope('2606:4700::1111'), 'public');
    assert.equal(getIpScope('::ffff:127.0.0.1'), 'loopback');
    assert.equal(getIpScope('::ffff:8.8.8.8'), 'public');
    assert.equal(getIpScope('::'), 'unspecified');
});

test('detects invalid and loopback addresses', () => {
    assert.equal(getIpScope('not-an-ip'), 'invalid');
    assert.equal(getIpScope(''), 'invalid');
    assert.equal(isLoopbackIp('127.0.0.2'), true);
    assert.equal(isLoopbackIp('::1'), true);
    assert.equal(isLoopbackIp('8.8.8.8'), false);
    assert.equal(isPrivateOrLocalIp('192.168.0.10'), true);
    assert.equal(isPrivateOrLocalIp('8.8.8.8'), false);
});

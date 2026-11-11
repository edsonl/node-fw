import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigError, loadConfig, toSafeConfig } from '../src/config/index.js';

test('loadConfig applies safe defaults', () => {
    const config = loadConfig({});

    assert.equal(config.nodeEnv, 'development');
    assert.equal(config.serviceName, 'node-fw');
    assert.equal(config.logLevel, 'info');
    assert.equal(config.logEvents, false);
    assert.equal(config.api.host, '127.0.0.1');
    assert.equal(config.api.port, 8088);
    assert.equal(config.udp.host, '127.0.0.1');
    assert.equal(config.udp.port, 5514);
    assert.equal(config.udp.syslogTag, 'nodefw');
    assert.equal(config.event.userAgentMaxLength, 512);
    assert.equal(config.redis.database, 7);
    assert.equal(config.redis.prefix, 'nodfw:v1');
    assert.equal(config.redis.batchSize, 200);
    assert.equal(config.redis.queueMaxSize, 10000);
    assert.equal(config.redis.eventStreamEnabled, true);
    assert.equal(config.maxmind.enabled, true);
    assert.match(config.maxmind.dbDir, /data\/geolite2$/);
    assert.equal(config.maxmind.refreshMaxAgeDays, 3);
    assert.equal(config.maxmind.downloadRetries, 3);
    assert.equal(config.maxmind.cacheMaxEntries, 10000);
    assert.match(config.classification.configPath, /config\/classification\.json$/);
});

test('loadConfig parses explicit values', () => {
    const config = loadConfig({
        NODE_ENV: 'production',
        SERVICE_NAME: 'node-fw-prod',
        LOG_LEVEL: 'debug',
        LOG_EVENTS: 'true',
        API_HOST: '::1',
        API_PORT: '9090',
        UDP_HOST: '::1',
        UDP_PORT: '5515',
        UDP_MAX_MESSAGE_BYTES: '4096',
        SYSLOG_TAG: 'security',
        USER_AGENT_MAX_LENGTH: '256',
        SHUTDOWN_TIMEOUT_MS: '5000',
        REDIS_URL: 'redis://127.0.0.1:6380',
        REDIS_DB: '15',
        REDIS_PREFIX: 'nodefw:test',
        REDIS_FLUSH_INTERVAL_MS: '250',
        REDIS_BATCH_SIZE: '100',
        REDIS_QUEUE_MAX_SIZE: '5000',
        REDIS_EVENT_STREAM_ENABLED: 'false',
        REDIS_EVENT_STREAM_MAXLEN: '10000',
        MAXMIND_ENABLED: 'false',
        MAXMIND_DB_DIR: './tmp/maxmind-test',
        MAXMIND_ACCOUNT_ID: 'account-test',
        MAXMIND_LICENSE_KEY: 'license-test',
        MAXMIND_REFRESH_MAX_AGE_DAYS: '5',
        MAXMIND_DOWNLOAD_TIMEOUT_MS: '5000',
        MAXMIND_DOWNLOAD_RETRIES: '2',
        MAXMIND_RETRY_BACKOFF_MS: '0',
        MAXMIND_CACHE_MAX_ENTRIES: '500',
        MAXMIND_CACHE_TTL_MS: '60000',
        MAXMIND_LOCK_STALE_MS: '120000',
        CLASSIFICATION_CONFIG_PATH: './config/classification-test.json',
    });

    assert.equal(config.nodeEnv, 'production');
    assert.equal(config.serviceName, 'node-fw-prod');
    assert.equal(config.logLevel, 'debug');
    assert.equal(config.logEvents, true);
    assert.equal(config.api.host, '::1');
    assert.equal(config.api.port, 9090);
    assert.equal(config.udp.host, '::1');
    assert.equal(config.udp.port, 5515);
    assert.equal(config.udp.maxMessageBytes, 4096);
    assert.equal(config.udp.syslogTag, 'security');
    assert.equal(config.event.userAgentMaxLength, 256);
    assert.equal(config.shutdownTimeoutMs, 5000);
    assert.equal(config.redis.url, 'redis://127.0.0.1:6380');
    assert.equal(config.redis.database, 15);
    assert.equal(config.redis.prefix, 'nodefw:test');
    assert.equal(config.redis.flushIntervalMs, 250);
    assert.equal(config.redis.batchSize, 100);
    assert.equal(config.redis.queueMaxSize, 5000);
    assert.equal(config.redis.eventStreamEnabled, false);
    assert.equal(config.redis.eventStreamMaxlen, 10000);
    assert.equal(config.maxmind.enabled, false);
    assert.match(config.maxmind.dbDir, /tmp\/maxmind-test$/);
    assert.equal(config.maxmind.accountId, 'account-test');
    assert.equal(config.maxmind.licenseKey, 'license-test');
    assert.equal(config.maxmind.refreshMaxAgeDays, 5);
    assert.equal(config.maxmind.downloadTimeoutMs, 5000);
    assert.equal(config.maxmind.downloadRetries, 2);
    assert.equal(config.maxmind.retryBackoffMs, 0);
    assert.equal(config.maxmind.cacheMaxEntries, 500);
    assert.equal(config.maxmind.cacheTtlMs, 60000);
    assert.equal(config.maxmind.lockStaleMs, 120000);
    assert.match(config.classification.configPath, /config\/classification-test\.json$/);
});

test('loadConfig rejects non-loopback API and UDP hosts', () => {
    assert.throws(() => loadConfig({ API_HOST: '0.0.0.0' }), ConfigError);
    assert.throws(() => loadConfig({ UDP_HOST: '192.168.1.10' }), ConfigError);
});

test('loadConfig rejects invalid ports and sizes', () => {
    assert.throws(() => loadConfig({ API_PORT: '0' }), ConfigError);
    assert.throws(() => loadConfig({ UDP_PORT: '65536' }), ConfigError);
    assert.throws(() => loadConfig({ UDP_MAX_MESSAGE_BYTES: '100' }), ConfigError);
    assert.throws(() => loadConfig({ USER_AGENT_MAX_LENGTH: '10' }), ConfigError);
});

test('loadConfig rejects invalid booleans and enums', () => {
    assert.throws(() => loadConfig({ LOG_EVENTS: 'maybe' }), ConfigError);
    assert.throws(() => loadConfig({ LOG_LEVEL: 'verbose' }), ConfigError);
});

test('loadConfig rejects invalid names and tags', () => {
    assert.throws(() => loadConfig({ SERVICE_NAME: 'Node FW' }), ConfigError);
    assert.throws(() => loadConfig({ SYSLOG_TAG: 'nodefw tag' }), ConfigError);
});

test('loadConfig rejects invalid Redis settings', () => {
    assert.throws(() => loadConfig({ REDIS_URL: 'http://127.0.0.1:6379' }), ConfigError);
    assert.throws(() => loadConfig({ REDIS_URL: 'not-a-url' }), ConfigError);
    assert.throws(() => loadConfig({ REDIS_DB: '16' }), ConfigError);
    assert.throws(() => loadConfig({ REDIS_PREFIX: 'prefix with spaces' }), ConfigError);
    assert.throws(() => loadConfig({ REDIS_BATCH_SIZE: '0' }), ConfigError);
    assert.throws(() => loadConfig({ REDIS_EVENT_STREAM_MAXLEN: '10' }), ConfigError);
});

test('loadConfig rejects invalid MaxMind settings', () => {
    assert.throws(() => loadConfig({ MAXMIND_ENABLED: 'maybe' }), ConfigError);
    assert.throws(() => loadConfig({ MAXMIND_REFRESH_MAX_AGE_DAYS: '0' }), ConfigError);
    assert.throws(() => loadConfig({ MAXMIND_DOWNLOAD_RETRIES: '99' }), ConfigError);
    assert.throws(() => loadConfig({ MAXMIND_CACHE_MAX_ENTRIES: '10' }), ConfigError);
    assert.throws(() => loadConfig({ MAXMIND_CACHE_TTL_MS: '10' }), ConfigError);
    assert.throws(() => loadConfig({ MAXMIND_LICENSE_KEY: 'x'.repeat(300) }), ConfigError);
});

test('toSafeConfig returns only configuration fields', () => {
    const safe = toSafeConfig(loadConfig({
        LOG_LEVEL: 'silent',
        REDIS_URL: 'redis://user:secret@127.0.0.1:6379',
        MAXMIND_ACCOUNT_ID: 'account-secret',
        MAXMIND_LICENSE_KEY: 'license-secret',
    }));

    assert.equal(safe.logLevel, 'silent');
    assert.equal(safe.api.port, 8088);
    assert.equal(safe.udp.port, 5514);
    assert.equal('MAXMIND_LICENSE_KEY' in safe, false);
    assert.equal('url' in safe.redis, false);
    assert.equal('accountId' in safe.maxmind, false);
    assert.equal('licenseKey' in safe.maxmind, false);
    assert.match(safe.classification.configPath, /classification\.json$/);
    assert.equal(JSON.stringify(safe).includes('secret'), false);
});

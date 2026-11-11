import { resolve } from 'node:path';

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SYSLOG_TAG_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const REDIS_PREFIX_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

const DEFAULTS = Object.freeze({
    nodeEnv: 'development',
    serviceName: 'node-fw',
    logLevel: 'info',
    logEvents: false,
    apiHost: '127.0.0.1',
    apiPort: 8088,
    apiBodyLimitBytes: 1024 * 1024,
    udpHost: '127.0.0.1',
    udpPort: 5514,
    udpMaxMessageBytes: 8192,
    udpRecvBufferBytes: 1024 * 1024,
    syslogTag: 'nodefw',
    userAgentMaxLength: 512,
    shutdownTimeoutMs: 10000,
    redisUrl: 'redis://127.0.0.1:6379',
    redisDb: 7,
    redisPrefix: 'nodfw:v1',
    redisConnectTimeoutMs: 2000,
    redisWriteTimeoutMs: 2000,
    redisReconnectMaxDelayMs: 5000,
    redisFlushIntervalMs: 100,
    redisBatchSize: 200,
    redisQueueMaxSize: 10000,
    redisEventStreamEnabled: true,
    redisEventStreamMaxlen: 50000,
    maxmindEnabled: true,
    maxmindDbDir: './data/geolite2',
    maxmindRefreshMaxAgeDays: 3,
    maxmindDownloadTimeoutMs: 120000,
    maxmindDownloadRetries: 3,
    maxmindRetryBackoffMs: 500,
    maxmindCacheMaxEntries: 10000,
    maxmindCacheTtlMs: 300000,
    maxmindLockStaleMs: 900000,
    classificationConfigPath: './config/classification.json',
});

export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
        this.code = 'CONFIG_INVALID';
    }
}

function readRaw(env, name) {
    const value = env[name];
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

function readString(env, name, fallback, maxLength) {
    const value = readRaw(env, name) ?? fallback;
    if (value.length > maxLength) {
        throw new ConfigError(`${name} exceeds the maximum length`);
    }

    return value;
}

function readOptionalString(env, name, maxLength) {
    const value = readRaw(env, name);
    if (value === undefined) {
        return '';
    }
    if (value.length > maxLength) {
        throw new ConfigError(`${name} exceeds the maximum length`);
    }

    return value;
}

function readInteger(env, name, fallback, min, max) {
    const value = readRaw(env, name);
    if (value === undefined) {
        return fallback;
    }

    if (!/^-?\d+$/.test(value)) {
        throw new ConfigError(`${name} must be an integer`);
    }

    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
        throw new ConfigError(`${name} must be between ${min} and ${max}`);
    }

    return number;
}

function readBoolean(env, name, fallback) {
    const value = readRaw(env, name);
    if (value === undefined) {
        return fallback;
    }

    switch (value.toLowerCase()) {
        case 'true':
        case '1':
        case 'yes':
        case 'on':
            return true;
        case 'false':
        case '0':
        case 'no':
        case 'off':
            return false;
        default:
            throw new ConfigError(`${name} must be a boolean`);
    }
}

function readEnum(env, name, fallback, allowed) {
    const value = readRaw(env, name) ?? fallback;
    if (!allowed.has(value)) {
        throw new ConfigError(`${name} must be one of: ${[...allowed].join(', ')}`);
    }

    return value;
}

function readPattern(env, name, fallback, pattern) {
    const value = readRaw(env, name) ?? fallback;
    if (!pattern.test(value)) {
        throw new ConfigError(`${name} has an invalid format`);
    }

    return value;
}

function readLoopbackHost(env, name, fallback) {
    const value = readRaw(env, name) ?? fallback;
    if (!LOOPBACK_HOSTS.has(value)) {
        throw new ConfigError(`${name} must be 127.0.0.1 or ::1`);
    }

    return value;
}

function readRedisUrl(env, name, fallback) {
    const value = readRaw(env, name) ?? fallback;

    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new ConfigError(`${name} must be a valid redis:// or rediss:// URL`);
    }

    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
        throw new ConfigError(`${name} must use redis:// or rediss://`);
    }

    return value;
}

export function loadConfig(env = process.env) {
    const nodeEnv = readString(env, 'NODE_ENV', DEFAULTS.nodeEnv, 32);
    const serviceName = readPattern(env, 'SERVICE_NAME', DEFAULTS.serviceName, SERVICE_NAME_PATTERN);
    const logLevel = readEnum(env, 'LOG_LEVEL', DEFAULTS.logLevel, LOG_LEVELS);
    const logEvents = readBoolean(env, 'LOG_EVENTS', DEFAULTS.logEvents);

    const apiHost = readLoopbackHost(env, 'API_HOST', DEFAULTS.apiHost);
    const apiPort = readInteger(env, 'API_PORT', DEFAULTS.apiPort, 1, 65535);
    const apiBodyLimitBytes = readInteger(
        env,
        'API_BODY_LIMIT_BYTES',
        DEFAULTS.apiBodyLimitBytes,
        1024,
        10 * 1024 * 1024
    );

    const udpHost = readLoopbackHost(env, 'UDP_HOST', DEFAULTS.udpHost);
    const udpPort = readInteger(env, 'UDP_PORT', DEFAULTS.udpPort, 1, 65535);
    const udpMaxMessageBytes = readInteger(
        env,
        'UDP_MAX_MESSAGE_BYTES',
        DEFAULTS.udpMaxMessageBytes,
        512,
        65507
    );
    const udpRecvBufferBytes = readInteger(
        env,
        'UDP_RECV_BUFFER_BYTES',
        DEFAULTS.udpRecvBufferBytes,
        65536,
        16 * 1024 * 1024
    );
    const syslogTag = readPattern(env, 'SYSLOG_TAG', DEFAULTS.syslogTag, SYSLOG_TAG_PATTERN);

    const userAgentMaxLength = readInteger(
        env,
        'USER_AGENT_MAX_LENGTH',
        DEFAULTS.userAgentMaxLength,
        64,
        4096
    );
    const shutdownTimeoutMs = readInteger(
        env,
        'SHUTDOWN_TIMEOUT_MS',
        DEFAULTS.shutdownTimeoutMs,
        1000,
        60000
    );

    const redisUrl = readRedisUrl(env, 'REDIS_URL', DEFAULTS.redisUrl);
    const redisDb = readInteger(env, 'REDIS_DB', DEFAULTS.redisDb, 0, 15);
    const redisPrefix = readPattern(env, 'REDIS_PREFIX', DEFAULTS.redisPrefix, REDIS_PREFIX_PATTERN);
    const redisConnectTimeoutMs = readInteger(
        env,
        'REDIS_CONNECT_TIMEOUT_MS',
        DEFAULTS.redisConnectTimeoutMs,
        100,
        30000
    );
    const redisWriteTimeoutMs = readInteger(
        env,
        'REDIS_WRITE_TIMEOUT_MS',
        DEFAULTS.redisWriteTimeoutMs,
        100,
        30000
    );
    const redisReconnectMaxDelayMs = readInteger(
        env,
        'REDIS_RECONNECT_MAX_DELAY_MS',
        DEFAULTS.redisReconnectMaxDelayMs,
        100,
        60000
    );
    const redisFlushIntervalMs = readInteger(
        env,
        'REDIS_FLUSH_INTERVAL_MS',
        DEFAULTS.redisFlushIntervalMs,
        20,
        5000
    );
    const redisBatchSize = readInteger(env, 'REDIS_BATCH_SIZE', DEFAULTS.redisBatchSize, 1, 5000);
    const redisQueueMaxSize = readInteger(
        env,
        'REDIS_QUEUE_MAX_SIZE',
        DEFAULTS.redisQueueMaxSize,
        1000,
        1000000
    );
    const redisEventStreamEnabled = readBoolean(
        env,
        'REDIS_EVENT_STREAM_ENABLED',
        DEFAULTS.redisEventStreamEnabled
    );
    const redisEventStreamMaxlen = readInteger(
        env,
        'REDIS_EVENT_STREAM_MAXLEN',
        DEFAULTS.redisEventStreamMaxlen,
        1000,
        1000000
    );

    const maxmindEnabled = readBoolean(env, 'MAXMIND_ENABLED', DEFAULTS.maxmindEnabled);
    const maxmindDbDir = resolve(
        process.cwd(),
        readString(env, 'MAXMIND_DB_DIR', DEFAULTS.maxmindDbDir, 512)
    );
    const maxmindAccountId = readOptionalString(env, 'MAXMIND_ACCOUNT_ID', 64);
    const maxmindLicenseKey = readOptionalString(env, 'MAXMIND_LICENSE_KEY', 256);
    const maxmindRefreshMaxAgeDays = readInteger(
        env,
        'MAXMIND_REFRESH_MAX_AGE_DAYS',
        DEFAULTS.maxmindRefreshMaxAgeDays,
        1,
        90
    );
    const maxmindDownloadTimeoutMs = readInteger(
        env,
        'MAXMIND_DOWNLOAD_TIMEOUT_MS',
        DEFAULTS.maxmindDownloadTimeoutMs,
        1000,
        600000
    );
    const maxmindDownloadRetries = readInteger(
        env,
        'MAXMIND_DOWNLOAD_RETRIES',
        DEFAULTS.maxmindDownloadRetries,
        0,
        5
    );
    const maxmindRetryBackoffMs = readInteger(
        env,
        'MAXMIND_RETRY_BACKOFF_MS',
        DEFAULTS.maxmindRetryBackoffMs,
        0,
        60000
    );
    const maxmindCacheMaxEntries = readInteger(
        env,
        'MAXMIND_CACHE_MAX_ENTRIES',
        DEFAULTS.maxmindCacheMaxEntries,
        100,
        100000
    );
    const maxmindCacheTtlMs = readInteger(
        env,
        'MAXMIND_CACHE_TTL_MS',
        DEFAULTS.maxmindCacheTtlMs,
        1000,
        86400000
    );
    const maxmindLockStaleMs = readInteger(
        env,
        'MAXMIND_LOCK_STALE_MS',
        DEFAULTS.maxmindLockStaleMs,
        60000,
        86400000
    );

    const classificationConfigPath = resolve(
        process.cwd(),
        readString(
            env,
            'CLASSIFICATION_CONFIG_PATH',
            DEFAULTS.classificationConfigPath,
            512
        )
    );

    return Object.freeze({
        nodeEnv,
        serviceName,
        logLevel,
        logEvents,
        api: Object.freeze({
            host: apiHost,
            port: apiPort,
            bodyLimitBytes: apiBodyLimitBytes,
        }),
        udp: Object.freeze({
            host: udpHost,
            port: udpPort,
            maxMessageBytes: udpMaxMessageBytes,
            recvBufferBytes: udpRecvBufferBytes,
            syslogTag,
        }),
        event: Object.freeze({
            userAgentMaxLength,
        }),
        redis: Object.freeze({
            url: redisUrl,
            database: redisDb,
            prefix: redisPrefix,
            connectTimeoutMs: redisConnectTimeoutMs,
            writeTimeoutMs: redisWriteTimeoutMs,
            reconnectMaxDelayMs: redisReconnectMaxDelayMs,
            flushIntervalMs: redisFlushIntervalMs,
            batchSize: redisBatchSize,
            queueMaxSize: redisQueueMaxSize,
            eventStreamEnabled: redisEventStreamEnabled,
            eventStreamMaxlen: redisEventStreamMaxlen,
        }),
        maxmind: Object.freeze({
            enabled: maxmindEnabled,
            dbDir: maxmindDbDir,
            accountId: maxmindAccountId,
            licenseKey: maxmindLicenseKey,
            refreshMaxAgeDays: maxmindRefreshMaxAgeDays,
            downloadTimeoutMs: maxmindDownloadTimeoutMs,
            downloadRetries: maxmindDownloadRetries,
            retryBackoffMs: maxmindRetryBackoffMs,
            cacheMaxEntries: maxmindCacheMaxEntries,
            cacheTtlMs: maxmindCacheTtlMs,
            lockStaleMs: maxmindLockStaleMs,
        }),
        classification: Object.freeze({
            configPath: classificationConfigPath,
        }),
        shutdownTimeoutMs,
    });
}

export function toSafeConfig(config) {
    return {
        nodeEnv: config.nodeEnv,
        serviceName: config.serviceName,
        logLevel: config.logLevel,
        logEvents: config.logEvents,
        api: {
            host: config.api.host,
            port: config.api.port,
            bodyLimitBytes: config.api.bodyLimitBytes,
        },
        udp: {
            host: config.udp.host,
            port: config.udp.port,
            maxMessageBytes: config.udp.maxMessageBytes,
            recvBufferBytes: config.udp.recvBufferBytes,
            syslogTag: config.udp.syslogTag,
        },
        event: {
            userAgentMaxLength: config.event.userAgentMaxLength,
        },
        redis: {
            database: config.redis.database,
            prefix: config.redis.prefix,
            connectTimeoutMs: config.redis.connectTimeoutMs,
            writeTimeoutMs: config.redis.writeTimeoutMs,
            reconnectMaxDelayMs: config.redis.reconnectMaxDelayMs,
            flushIntervalMs: config.redis.flushIntervalMs,
            batchSize: config.redis.batchSize,
            queueMaxSize: config.redis.queueMaxSize,
            eventStreamEnabled: config.redis.eventStreamEnabled,
            eventStreamMaxlen: config.redis.eventStreamMaxlen,
        },
        maxmind: {
            enabled: config.maxmind.enabled,
            dbDir: config.maxmind.dbDir,
            refreshMaxAgeDays: config.maxmind.refreshMaxAgeDays,
            downloadTimeoutMs: config.maxmind.downloadTimeoutMs,
            downloadRetries: config.maxmind.downloadRetries,
            retryBackoffMs: config.maxmind.retryBackoffMs,
            cacheMaxEntries: config.maxmind.cacheMaxEntries,
            cacheTtlMs: config.maxmind.cacheTtlMs,
            lockStaleMs: config.maxmind.lockStaleMs,
        },
        classification: {
            configPath: config.classification.configPath,
        },
        shutdownTimeoutMs: config.shutdownTimeoutMs,
    };
}

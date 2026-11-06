import { createClient } from 'redis';

import { StorageNotReadyError } from './errors.js';

function nowIso() {
    return new Date().toISOString();
}

function safeErrorMessage(error) {
    return error instanceof Error ? error.message : 'Redis error';
}

export function createRedisClient({ config, logger = null }) {
    const {
        url,
        database,
        prefix,
        connectTimeoutMs,
        reconnectMaxDelayMs,
    } = config;

    const state = {
        reconnectAttempts: 0,
        lastConnectedAt: null,
        lastError: null,
    };

    let lastErrorLogAt = 0;
    let closed = false;
    let connectPromise = null;

    const client = createClient({
        url,
        database,
        disableOfflineQueue: true,
        socket: {
            connectTimeout: connectTimeoutMs,
            reconnectStrategy: (retries) => {
                state.reconnectAttempts = retries + 1;
                return Math.min(100 * (2 ** Math.min(retries, 6)), reconnectMaxDelayMs);
            },
        },
    });

    client.on('error', (error) => {
        state.lastError = { message: safeErrorMessage(error), at: nowIso() };

        const now = Date.now();
        if (now - lastErrorLogAt >= 30_000) {
            lastErrorLogAt = now;
            logger?.warn(
                { code: error?.code ?? null, message: safeErrorMessage(error) },
                'redis connection error'
            );
        }
    });

    client.on('ready', () => {
        state.reconnectAttempts = 0;
        state.lastConnectedAt = nowIso();
        state.lastError = null;
        logger?.info({ database, prefix }, 'redis ready');
    });

    client.on('reconnecting', () => {
        logger?.debug({ database, attempt: state.reconnectAttempts }, 'redis reconnecting');
    });

    client.on('end', () => {
        if (closed) {
            logger?.debug({ database }, 'redis connection closed');
            return;
        }
        logger?.warn({ database }, 'redis connection closed unexpectedly');
    });

    function connect() {
        if (closed) {
            return Promise.reject(new StorageNotReadyError('Redis client is closed'));
        }
        if (client.isReady) {
            return Promise.resolve();
        }
        if (connectPromise) {
            return connectPromise;
        }

        connectPromise = client.connect()
            .catch((error) => {
                state.lastError = { message: safeErrorMessage(error), at: nowIso() };
                logger?.error(
                    { code: error?.code ?? null, message: safeErrorMessage(error) },
                    'redis failed to connect'
                );
            })
            .finally(() => {
                connectPromise = null;
            });

        return connectPromise;
    }

    async function close() {
        if (closed) {
            return;
        }
        closed = true;

        if (!client.isOpen) {
            client.destroy();
            return;
        }

        try {
            await client.quit();
        } catch {
            client.destroy();
            return;
        }

        if (client.isOpen) {
            client.destroy();
        }
    }

    function isReady() {
        return client.isReady;
    }

    function assertReady() {
        if (!client.isReady) {
            throw new StorageNotReadyError();
        }
    }

    function getStats() {
        return {
            ready: client.isReady,
            open: client.isOpen,
            database,
            prefix,
            reconnectAttempts: state.reconnectAttempts,
            lastConnectedAt: state.lastConnectedAt,
            lastError: state.lastError,
        };
    }

    return {
        client,
        connect,
        close,
        isReady,
        assertReady,
        getStats,
    };
}

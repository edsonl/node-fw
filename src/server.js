import { buildApp } from './app.js';
import { createSyslogCollector } from './collector/syslog-collector.js';
import { loadConfig, toSafeConfig } from './config/index.js';
import { loadEnvFile } from './config/load-env.js';
import { createEventAggregator } from './storage/aggregator.js';
import { createEventQueue } from './storage/event-queue.js';
import { createRedisQueries } from './storage/queries.js';
import { createRedisClient } from './storage/redis-client.js';

async function main() {
    let envFileLoaded = false;
    try {
        envFileLoaded = loadEnvFile();
    } catch (error) {
        process.stderr.write(`node-fw: ${error.message}\n`);
        process.exitCode = 1;
        return;
    }

    let config;
    try {
        config = loadConfig();
    } catch (error) {
        process.stderr.write(`node-fw: ${error.message}\n`);
        process.exitCode = 1;
        return;
    }

    let collector = null;
    let aggregator = null;
    let redisClient = null;
    let queries = null;

    const app = buildApp({
        config,
        getCollectorStats: () => collector?.getStats() ?? null,
        getPipelineStats: () => aggregator?.getStats() ?? null,
        getRedisStats: () => redisClient?.getStats() ?? null,
        getSummary: (options) => queries.getSummary(options),
        getRecentEvents: (options) => queries.getRecentEvents(options),
    });

    app.log.info(
        {
            config: toSafeConfig(config),
            envFileLoaded,
        },
        'node-fw starting'
    );

    redisClient = createRedisClient({
        config: config.redis,
        logger: app.log,
    });

    const eventQueue = createEventQueue({
        maxSize: config.redis.queueMaxSize,
    });

    aggregator = createEventAggregator({
        redis: redisClient,
        queue: eventQueue,
        config: config.redis,
        logger: app.log,
    });

    queries = createRedisQueries({
        redis: redisClient,
        config: config.redis,
    });

    collector = createSyslogCollector({
        host: config.udp.host,
        port: config.udp.port,
        tag: config.udp.syslogTag,
        maxMessageBytes: config.udp.maxMessageBytes,
        recvBufferBytes: config.udp.recvBufferBytes,
        userAgentMaxLength: config.event.userAgentMaxLength,
        logger: app.log,
        onEvent: (event) => {
            eventQueue.push(event);
            if (eventQueue.size() >= config.redis.batchSize) {
                aggregator.flushSoon();
            }

            if (config.logEvents) {
                app.log.debug(
                    {
                        requestId: event.requestId,
                        site: event.site,
                        ip: event.ip,
                        method: event.method,
                        path: event.path,
                        status: event.status,
                        dynamic: event.dynamic,
                    },
                    'event accepted'
                );
            }
        },
        onInvalid: (invalid) => {
            if (config.logEvents) {
                app.log.debug({ invalid }, 'event rejected');
            }
        },
    });

    let shuttingDown = false;

    async function shutdown(signal) {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;

        app.log.info({ signal }, 'shutting down node-fw');
        const forceTimer = setTimeout(() => {
            app.log.fatal('forced shutdown after timeout');
            process.exit(1);
        }, config.shutdownTimeoutMs);
        forceTimer.unref();

        let exitCode = 0;
        try {
            await collector.stop();
            await aggregator.stop();
            eventQueue.stop();
            await redisClient.close();
            await app.close();
        } catch (error) {
            exitCode = 1;
            app.log.error({ err: error }, 'shutdown failed');
        }

        process.exitCode = exitCode;
    }

    try {
        void redisClient.connect();
        aggregator.start();

        const syslogAddress = await collector.start();
        await app.listen({ host: config.api.host, port: config.api.port });

        process.once('SIGINT', () => void shutdown('SIGINT'));
        process.once('SIGTERM', () => void shutdown('SIGTERM'));

        app.log.info(
            {
                syslog: syslogAddress,
                api: `${config.api.host}:${config.api.port}`,
                redisReady: redisClient.isReady(),
            },
            'node-fw ready'
        );
    } catch (error) {
        app.log.fatal({ err: error }, 'failed to start node-fw');
        await collector.stop().catch(() => {});
        await aggregator.stop().catch(() => {});
        eventQueue.stop();
        await redisClient.close().catch(() => {});
        await app.close().catch(() => {});
        process.exitCode = 1;
    }
}

main().catch((error) => {
    process.stderr.write(`node-fw failed to start: ${error.message}\n`);
    process.exitCode = 1;
});

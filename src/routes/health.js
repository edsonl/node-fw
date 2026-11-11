import { VERSION } from '../version.js';

export async function healthRoutes(app, options) {
    const {
        getCollectorStats = () => null,
        getPipelineStats = () => null,
        getRedisStats = () => null,
        getMaxMindStats = () => null,
        getClassificationStats = () => null,
        getSummary = null,
        serviceName = 'node-fw',
    } = options;

    app.get('/api/health', async (request, reply) => {
        const collector = getCollectorStats();
        const redis = getRedisStats();
        const maxmind = getMaxMindStats();
        const classification = getClassificationStats();

        reply.header('Cache-Control', 'no-store');
        return {
            status: 'ok',
            service: serviceName,
            version: VERSION,
            timestamp: new Date().toISOString(),
            uptimeSeconds: Math.floor(process.uptime()),
            collector: collector
                ? {
                    started: collector.started,
                    address: collector.address,
                }
                : null,
            redis: redis
                ? {
                    ready: redis.ready,
                    database: redis.database,
                }
                : null,
            maxmind: maxmind
                ? {
                    enabled: maxmind.enabled,
                    countryReady: maxmind.countryReady,
                    asnReady: maxmind.asnReady,
                    degraded: maxmind.degraded,
                }
                : null,
            classification: classification
                ? {
                    decisions: classification.decisions,
                    levels: classification.levelCounts,
                    modeCounts: classification.modeCounts,
                }
                : null,
        };
    });

    app.get('/api/ready', async (request, reply) => {
        const collector = getCollectorStats();
        const redis = getRedisStats();
        const maxmind = getMaxMindStats();
        const classification = getClassificationStats();
        const collectorReady = Boolean(collector?.started);
        const redisRequired = redis !== null && redis !== undefined;
        const redisReady = !redisRequired || redis.ready === true;
        const ready = collectorReady && redisReady;
        const maxmindStatus = maxmind
            ? (maxmind.countryReady && maxmind.asnReady ? 'ok' : 'degraded')
            : 'not_configured';

        reply.header('Cache-Control', 'no-store');
        reply.code(ready ? 200 : 503);
        return {
            status: ready ? 'ready' : 'not_ready',
            timestamp: new Date().toISOString(),
            checks: {
                collector: collectorReady ? 'ok' : 'down',
                redis: redisRequired ? (redisReady ? 'ok' : 'down') : 'not_configured',
                maxmind: maxmindStatus,
                classification: classification ? 'ok' : 'not_configured',
            },
        };
    });

    app.get('/api/stats', async (request, reply) => {
        const collector = getCollectorStats();
        const pipeline = getPipelineStats();
        const redis = getRedisStats();
        const maxmind = getMaxMindStats();
        const classification = getClassificationStats();

        reply.header('Cache-Control', 'no-store');
        if (!collector) {
            reply.code(503);
            return {
                status: 'not_ready',
                timestamp: new Date().toISOString(),
                collector: null,
                pipeline,
                redis,
                maxmind,
                classification,
            };
        }

        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            collector,
            pipeline,
            redis,
            maxmind,
            classification,
        };
    });

    app.get('/api/summary', async (request, reply) => {
        reply.header('Cache-Control', 'no-store');

        if (typeof getSummary !== 'function') {
            reply.code(503);
            return { error: 'summary_unavailable' };
        }

        try {
            const summary = await getSummary({ site: request.query?.site });
            return {
                status: 'ok',
                ...summary,
            };
        } catch (error) {
            if (error?.code === 'INVALID_QUERY') {
                reply.code(400);
                return { error: 'invalid_query' };
            }
            if (error?.code === 'STORAGE_NOT_READY') {
                reply.code(503);
                return { error: 'storage_not_ready' };
            }

            request.log.error({ err: error }, 'summary query failed');
            reply.code(500);
            return { error: 'internal_error' };
        }
    });
}

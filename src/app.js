import { randomUUID } from 'node:crypto';

import Fastify, { LogController } from 'fastify';

import { healthRoutes } from './routes/health.js';
import { panelRoutes } from './routes/panel.js';

const REDACT_PATHS = [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'res.headers["set-cookie"]',
];

export function buildApp({
    config,
    getCollectorStats = () => null,
    getPipelineStats = () => null,
    getRedisStats = () => null,
    getMaxMindStats = () => null,
    getClassificationStats = () => null,
    getSummary = null,
    getRecentEvents = null,
    logger,
} = {}) {
    if (!config) {
        throw new Error('config is required');
    }

    const loggerOption = logger === undefined
        ? {
            level: config.logLevel,
            base: { service: config.serviceName },
            redact: REDACT_PATHS,
        }
        : logger;

    const app = Fastify({
        logger: loggerOption,
        bodyLimit: config.api.bodyLimitBytes,
        logController: new LogController({ disableRequestLogging: true }),
        requestIdHeader: false,
        genReqId: () => randomUUID(),
        trustProxy: false,
    });

    app.register(healthRoutes, {
        getCollectorStats,
        getPipelineStats,
        getRedisStats,
        getMaxMindStats,
        getClassificationStats,
        getSummary,
        serviceName: config.serviceName,
    });

    app.register(panelRoutes, {
        getRecentEvents,
    });

    app.setNotFoundHandler((request, reply) => {
        reply.code(404).send({ error: 'not_found' });
    });

    app.setErrorHandler((error, request, reply) => {
        const requestedStatus = Number.isInteger(error.statusCode) ? error.statusCode : 500;
        const statusCode = requestedStatus >= 400 && requestedStatus <= 599 ? requestedStatus : 500;

        if (statusCode >= 500) {
            request.log.error({ err: error }, 'request failed');
        } else {
            request.log.warn({ err: error }, 'request rejected');
        }

        reply.code(statusCode).send({
            error: statusCode >= 500 ? 'internal_error' : (error.code || 'request_error'),
        });
    });

    return app;
}

import { buildAggregationPlan } from './aggregation-plan.js';
import { StorageNotReadyError } from './errors.js';

function nowIso() {
    return new Date().toISOString();
}

function safeErrorMessage(error) {
    return error instanceof Error ? error.message : 'Redis error';
}

function withTimeout(promise, timeoutMs, label) {
    let timer;

    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        timer.unref?.();
    });

    return Promise.race([promise, timeout]).finally(() => {
        clearTimeout(timer);
    });
}

function appendCommand(multi, args) {
    multi.addCommand(args);
}

export async function writeAggregationPlan(client, plan, timeoutMs) {
    if (!client.isReady) {
        throw new StorageNotReadyError();
    }

    const multi = client.multi();

    for (const entry of plan.counters) {
        appendCommand(multi, ['INCRBY', entry.key, String(entry.amount)]);
        appendCommand(multi, ['EXPIRE', entry.key, String(entry.ttl)]);
    }

    for (const entry of plan.zsets) {
        appendCommand(multi, ['ZINCRBY', entry.key, String(entry.amount), entry.member]);
        appendCommand(multi, ['EXPIRE', entry.key, String(entry.ttl)]);
    }

    for (const entry of plan.scoredZsets ?? []) {
        appendCommand(multi, ['ZADD', entry.key, String(entry.score), entry.member]);
        appendCommand(multi, ['EXPIRE', entry.key, String(entry.ttl)]);
    }

    for (const entry of plan.hashes) {
        appendCommand(multi, ['HINCRBY', entry.key, entry.field, String(entry.amount)]);
        appendCommand(multi, ['EXPIRE', entry.key, String(entry.ttl)]);
    }

    for (const entry of plan.hlls) {
        appendCommand(multi, ['PFADD', entry.key, ...entry.members]);
        appendCommand(multi, ['EXPIRE', entry.key, String(entry.ttl)]);
    }

    for (const entry of plan.sets) {
        appendCommand(multi, ['SADD', entry.key, ...entry.members]);
        appendCommand(multi, ['EXPIRE', entry.key, String(entry.ttl)]);
    }

    for (const entry of plan.reputations) {
        const fields = [
            'HSET', entry.key,
            'lastSeen', entry.lastSeen,
            'lastSite', entry.lastSite,
            'lastStatus', String(entry.lastStatus),
            'lastMethod', entry.lastMethod,
        ];
        if (entry.lastCountry) {
            fields.push('lastCountry', entry.lastCountry);
        }
        fields.push(
            'lastGeoProfile', entry.lastGeoProfile ?? '',
            'lastGeoFactor', String(entry.lastGeoFactor ?? 1),
            'lastGeoFallback', entry.lastGeoFallback ? '1' : '0'
        );
        fields.push(
            'score', String(entry.score ?? 0),
            'level', entry.level ?? 'normal',
            'reasons', entry.reasons ?? '[]',
            'scoredAt', entry.scoredAt ?? entry.lastSeen
        );

        appendCommand(multi, ['HSETNX', entry.key, 'firstSeen', entry.firstSeen]);
        appendCommand(multi, ['HINCRBY', entry.key, 'totalEvents', String(entry.count)]);
        appendCommand(multi, fields);
        appendCommand(multi, ['EXPIRE', entry.key, String(entry.ttl)]);
    }

    for (const entry of plan.streams) {
        appendCommand(multi, [
            'XADD',
            entry.key,
            'MAXLEN',
            '~',
            String(entry.maxlen),
            '*',
            ...entry.fields,
        ]);
    }

    const replies = await withTimeout(multi.exec(), timeoutMs, 'redis batch write');
    if (Array.isArray(replies)) {
        const error = replies.find((reply) => reply instanceof Error);
        if (error) {
            throw error;
        }
    }
}

export function createEventAggregator({ redis, queue, config, logger = null }) {
    const stats = {
        started: false,
        flushing: false,
        batches: 0,
        writtenEvents: 0,
        failedEvents: 0,
        writeFailures: 0,
        skippedFlushes: 0,
        circuitOpen: false,
        lastWriteAt: null,
        lastError: null,
        lastPlan: null,
        flushIntervalMs: config.flushIntervalMs,
        batchSize: config.batchSize,
    };

    let interval = null;
    let inFlight = null;
    let lastFailureLogAt = 0;
    let lastFlushSoonAt = 0;

    async function flushOnce() {
        if (inFlight) {
            return inFlight;
        }

        if (!redis.isReady()) {
            stats.circuitOpen = true;
            stats.skippedFlushes += 1;
            return { events: 0, written: 0, skipped: true };
        }

        stats.circuitOpen = false;
        const batch = queue.takeBatch(config.batchSize);
        if (batch.length === 0) {
            return { events: 0, written: 0 };
        }

        inFlight = (async () => {
            stats.flushing = true;
            try {
                const plan = buildAggregationPlan(batch, {
                    prefix: config.prefix,
                    eventStreamEnabled: config.eventStreamEnabled,
                    eventStreamMaxlen: config.eventStreamMaxlen,
                });
                await writeAggregationPlan(redis.client, plan, config.writeTimeoutMs);

                stats.batches += 1;
                stats.writtenEvents += batch.length;
                stats.lastWriteAt = nowIso();
                stats.lastError = null;
                stats.lastPlan = plan.stats;
                return { events: batch.length, written: batch.length };
            } catch (error) {
                stats.writeFailures += 1;
                stats.failedEvents += batch.length;
                const message = safeErrorMessage(error);
                stats.lastError = { message, at: nowIso() };

                const now = Date.now();
                if (now - lastFailureLogAt >= 30_000) {
                    lastFailureLogAt = now;
                    logger?.warn(
                        { code: error?.code ?? null, message, events: batch.length },
                        'redis batch write failed; events discarded'
                    );
                }

                return { events: batch.length, written: 0, error: message };
            } finally {
                stats.flushing = false;
                inFlight = null;
            }
        })();

        return inFlight;
    }

    function flushSoon() {
        const now = Date.now();
        if (now - lastFlushSoonAt < 50) {
            return;
        }
        lastFlushSoonAt = now;
        void flushOnce();
    }

    function start() {
        if (interval) {
            return;
        }

        stats.started = true;
        interval = setInterval(() => {
            void flushOnce();
        }, config.flushIntervalMs);
        interval.unref?.();
        logger?.info(
            { flushIntervalMs: config.flushIntervalMs, batchSize: config.batchSize },
            'redis aggregator started'
        );
    }

    async function stop() {
        if (interval) {
            clearInterval(interval);
            interval = null;
        }
        stats.started = false;

        if (inFlight) {
            await inFlight;
        }
        await flushOnce();
    }

    function getStats() {
        return {
            ...stats,
            queue: queue.getStats(),
        };
    }

    return {
        start,
        stop,
        flushOnce,
        flushSoon,
        getStats,
    };
}

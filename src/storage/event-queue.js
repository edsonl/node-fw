export function createEventQueue({ maxSize = 10000 } = {}) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
        throw new TypeError('Event queue maxSize must be a positive integer');
    }

    const stats = {
        maxSize,
        enqueued: 0,
        dequeued: 0,
        droppedOnOverflow: 0,
        droppedOnStop: 0,
        maxDepth: 0,
        currentDepth: 0,
        stopped: false,
    };

    let items = [];
    let stopped = false;

    function push(event) {
        if (stopped) {
            stats.droppedOnStop += 1;
            return false;
        }

        if (items.length >= maxSize) {
            items.shift();
            stats.droppedOnOverflow += 1;
        }

        items.push(event);
        stats.enqueued += 1;
        stats.currentDepth = items.length;
        if (items.length > stats.maxDepth) {
            stats.maxDepth = items.length;
        }

        return true;
    }

    function takeBatch(maxItems = 200) {
        if (stopped || items.length === 0) {
            return [];
        }

        const batch = items.splice(0, maxItems);
        stats.dequeued += batch.length;
        stats.currentDepth = items.length;
        return batch;
    }

    function size() {
        return items.length;
    }

    function stop() {
        if (stopped) {
            return 0;
        }

        stopped = true;
        stats.stopped = true;
        const remaining = items.length;
        items = [];
        stats.droppedOnStop += remaining;
        stats.currentDepth = 0;
        return remaining;
    }

    function getStats() {
        return {
            ...stats,
            currentDepth: items.length,
            droppedTotal: stats.droppedOnOverflow + stats.droppedOnStop,
        };
    }

    return {
        push,
        takeBatch,
        size,
        stop,
        getStats,
    };
}

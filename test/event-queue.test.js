import assert from 'node:assert/strict';
import test from 'node:test';

import { createEventQueue } from '../src/storage/event-queue.js';

test('event queue drops the oldest item when full', () => {
    const queue = createEventQueue({ maxSize: 3 });

    queue.push('a');
    queue.push('b');
    queue.push('c');
    queue.push('d');

    assert.equal(queue.size(), 3);
    assert.deepEqual(queue.takeBatch(2), ['b', 'c']);
    assert.equal(queue.size(), 1);
    assert.deepEqual(queue.takeBatch(10), ['d']);

    const stats = queue.getStats();
    assert.equal(stats.enqueued, 4);
    assert.equal(stats.dequeued, 3);
    assert.equal(stats.droppedOnOverflow, 1);
    assert.equal(stats.droppedTotal, 1);
    assert.equal(stats.maxDepth, 3);
    assert.equal(stats.currentDepth, 0);
});

test('event queue rejects new items after stop and drops the remainder', () => {
    const queue = createEventQueue({ maxSize: 10 });
    queue.push('a');
    queue.push('b');

    assert.equal(queue.stop(), 2);
    assert.equal(queue.push('c'), false);
    assert.deepEqual(queue.takeBatch(10), []);

    const stats = queue.getStats();
    assert.equal(stats.stopped, true);
    assert.equal(stats.droppedOnStop, 3);
    assert.equal(stats.droppedTotal, 3);
    assert.equal(stats.currentDepth, 0);
});

test('event queue validates maxSize', () => {
    assert.throws(() => createEventQueue({ maxSize: 0 }), /maxSize/);
    assert.throws(() => createEventQueue({ maxSize: 1.5 }), /maxSize/);
});

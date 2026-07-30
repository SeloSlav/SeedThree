import assert from 'node:assert/strict';
import {
  coalesceStreamSlotRequests,
  planSlotAttributeUpdateRanges,
  runStreamSlotUpdateChunk,
} from '../src/core/stream-slot-budget.js';

const oldPending = [
  { slotIndex: 3, worldX: 30, sortKey: 30 },
  { slotIndex: 1, worldX: 10, sortKey: 10 },
  { slotIndex: 7, worldX: 70, sortKey: 70 },
];
const newest = [
  { slotIndex: 1, worldX: 11, sortKey: 2 },
  { slotIndex: 4, worldX: 40, sortKey: 1 },
  { slotIndex: 3, worldX: 33, sortKey: 3 },
];
assert.deepEqual(
  coalesceStreamSlotRequests(oldPending, newest),
  {
    pending: [
      { slotIndex: 3, worldX: 33, sortKey: 3 },
      { slotIndex: 1, worldX: 11, sortKey: 2 },
      { slotIndex: 4, worldX: 40, sortKey: 1 },
    ],
    cancelledSlotIndices: [7],
  },
  'newest world mappings must replace stale slot work without losing queue stability',
);

const requests = Array.from({ length: 5 }, (_, slotIndex) => ({
  slotIndex,
  sortKey: slotIndex,
}));
const progress = new Map();
let pending = requests;
let fakeNowMs = 0;
let maxDurationMs = 0;
let totalWritten = 0;
for (let frame = 0; frame < 16 && pending.length > 0; frame++) {
  const result = runStreamSlotUpdateChunk(pending, {
    maxDurationMs: 1.2,
    minimumHeadroomMs: 0.4,
    maxSubsteps: 8,
    now: () => fakeNowMs,
    applySubstep(request) {
      fakeNowMs += 0.4;
      const next = (progress.get(request.slotIndex) ?? 0) + 1;
      progress.set(request.slotIndex, next);
      return {
        completed: next === 3,
        generated: 1,
        cleared: next === 3 ? 4 : 0,
        written: next === 3 ? 3 : 0,
        bytesWritten: next === 3 ? 48 : 0,
      };
    },
  });
  pending = result.pending;
  maxDurationMs = Math.max(maxDurationMs, result.durationMs);
  totalWritten += result.written;
  assert.ok(
    result.durationMs <= 1.2 + Number.EPSILON,
    `stream update exceeded available headroom (${result.durationMs}ms)`,
  );
}
assert.deepEqual(pending, [], 'resumable stream slots must converge');
assert.equal(totalWritten, 15);
assert.ok(maxDurationMs <= 1.2 + Number.EPSILON);

assert.deepEqual(
  planSlotAttributeUpdateRanges([5, 2, 3, 5], 10, 3),
  {
    ranges: [
      { start: 60, count: 60 },
      { start: 150, count: 30 },
    ],
    componentCount: 90,
    byteCount: 360,
  },
  'adjacent changed slots must merge into minimal component upload ranges',
);
assert.deepEqual(
  planSlotAttributeUpdateRanges([], 10, 16),
  { ranges: [], componentCount: 0, byteCount: 0 },
);

console.log('test:stream-slot-budget passed');

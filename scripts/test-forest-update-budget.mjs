import assert from 'node:assert/strict';
import { planForestBucketUpdates } from '../src/core/forest-update-budget.js';

const frozen = Array.from(
  { length: 8 },
  (_, index) => ({ near: [index], overview: [] }),
);
assert.deepEqual(
  planForestBucketUpdates(frozen, frozen, [], 1),
  { uploadBucketIndices: [], pendingBucketIndices: [] },
  'a frozen camera must schedule no buffer work',
);

const active = frozen.map((_, index) => ({ near: [], overview: [index] }));
let current = structuredClone(frozen);
let pending = [];
let largestBurst = 0;
for (let frame = 0; frame < active.length; frame += 1) {
  const plan = planForestBucketUpdates(current, active, pending, 1);
  largestBurst = Math.max(largestBurst, plan.uploadBucketIndices.length);
  for (const bucketIndex of plan.uploadBucketIndices) {
    current[bucketIndex] = structuredClone(active[bucketIndex]);
  }
  pending = plan.pendingBucketIndices;
}
assert.equal(largestBurst, 1, 'work must not exceed the requested per-frame budget');
assert.deepEqual(current, active, 'bounded work must converge to the full desired selection');
assert.deepEqual(pending, []);

const newer = active.map((selection, index) => (
  index === 7 ? { near: [7], overview: [] } : selection
));
assert.deepEqual(
  planForestBucketUpdates(current, newer, [3, 4, 5, 6, 7], 1),
  { uploadBucketIndices: [7], pendingBucketIndices: [] },
  'a newer selection must cancel stale pending work deterministically',
);

const unlimited = planForestBucketUpdates(frozen, active, [], Number.POSITIVE_INFINITY);
assert.deepEqual(
  unlimited,
  {
    uploadBucketIndices: [0, 1, 2, 3, 4, 5, 6, 7],
    pendingBucketIndices: [],
  },
  'an unlimited budget must preserve the eager update semantics',
);

console.log('test:forest-update-budget passed');

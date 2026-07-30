import assert from 'node:assert/strict';
import {
  coalesceForestBucketUpdates,
  planForestBucketUpdates,
  runForestBucketUpdateChunk,
} from '../src/core/forest-update-budget.js';

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
assert.deepEqual(
  coalesceForestBucketUpdates(current, newer, [3, 4, 5, 6, 7]),
  {
    pendingBucketIndices: [7],
    cancelledBucketIndices: [3, 4, 5, 6],
  },
  'coalescing must identify stale in-flight chunks for immediate cancellation',
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

const timedCurrent = structuredClone(frozen);
const timedDesired = structuredClone(active);
const chunkProgress = new Map();
let timedPending = [];
let fakeNowMs = 0;
let maxUpdateDurationMs = 0;
let maxChunksPerUpdate = 0;
for (let update = 0; update < 16; update += 1) {
  const result = runForestBucketUpdateChunk(
    timedCurrent,
    timedDesired,
    timedPending,
    {
      maxDurationMs: 1.8,
      minimumChunkHeadroomMs: 0.45,
      maxChunks: 8,
      maxBucketCompletions: 2,
      now: () => fakeNowMs,
      applyBucketChunk(bucketIndex) {
        fakeNowMs += 0.45;
        const progress = (chunkProgress.get(bucketIndex) ?? 0) + 1;
        chunkProgress.set(bucketIndex, progress);
        if (progress < 2) return false;
        timedCurrent[bucketIndex] = structuredClone(timedDesired[bucketIndex]);
        return true;
      },
    },
  );
  timedPending = result.pendingBucketIndices;
  maxUpdateDurationMs = Math.max(maxUpdateDurationMs, result.durationMs);
  maxChunksPerUpdate = Math.max(maxChunksPerUpdate, result.chunks);
  assert.ok(
    result.durationMs <= 1.8 + Number.EPSILON,
    `time-bounded update exceeded its 1.8ms headroom (${result.durationMs}ms)`,
  );
  if (timedPending.length === 0 && update > 0) break;
}
assert.ok(maxChunksPerUpdate <= 4, 'headroom must bound the number of chunks per update');
assert.ok(maxUpdateDurationMs <= 1.8 + Number.EPSILON);
assert.deepEqual(
  timedCurrent,
  timedDesired,
  'time/chunk bounded work must converge to the newest desired state',
);
assert.deepEqual(timedPending, [], 'settled work must converge to pending=0');

const reverted = structuredClone(timedDesired);
reverted[0] = structuredClone(frozen[0]);
const cancellation = runForestBucketUpdateChunk(
  timedDesired,
  reverted,
  [0, 1, 2],
  {
    maxDurationMs: 2,
    maxChunks: 1,
    now: () => fakeNowMs,
    applyBucketChunk(bucketIndex) {
      assert.equal(bucketIndex, 0);
      timedDesired[bucketIndex] = structuredClone(reverted[bucketIndex]);
      return true;
    },
  },
);
assert.deepEqual(
  cancellation.cancelledBucketIndices,
  [1, 2],
  'new desired state must discard stale queued chunks before executing work',
);
assert.deepEqual(cancellation.pendingBucketIndices, []);

const movingCurrent = structuredClone(frozen);
const movingFirstDesired = structuredClone(active);
const movingSecondDesired = structuredClone(active);
movingSecondDesired[0] = structuredClone(frozen[0]);
movingSecondDesired[1] = { near: [7, 1], overview: [] };
let movingPending = [];
let movingDesired = movingFirstDesired;
let movingNowMs = 0;
let activeBucketJob = null;
const publishedBuckets = [];
const cancelledActiveBuckets = [];

function runMovingUpdate(maxDurationMs = 1.6) {
  const result = runForestBucketUpdateChunk(
    movingCurrent,
    movingDesired,
    movingPending,
    {
      maxDurationMs,
      minimumChunkHeadroomMs: 0.2,
      maxChunks: 8,
      maxBucketCompletions: 1,
      now: () => movingNowMs,
      applyBucketChunk(bucketIndex) {
        movingNowMs += 0.3;
        if (activeBucketJob && activeBucketJob.bucketIndex !== bucketIndex) {
          cancelledActiveBuckets.push(activeBucketJob.bucketIndex);
          activeBucketJob = null;
        }
        if (!activeBucketJob) {
          activeBucketJob = { bucketIndex, slices: 0 };
        }
        activeBucketJob.slices++;
        if (activeBucketJob.slices < 3) return false;
        movingCurrent[bucketIndex] = structuredClone(movingDesired[bucketIndex]);
        publishedBuckets.push(bucketIndex);
        activeBucketJob = null;
        return true;
      },
    },
  );
  movingPending = result.pendingBucketIndices;
  if (
    activeBucketJob
    && result.cancelledBucketIndices.includes(activeBucketJob.bucketIndex)
  ) {
    cancelledActiveBuckets.push(activeBucketJob.bucketIndex);
    activeBucketJob = null;
  }
  assert.ok(result.durationMs <= maxDurationMs + Number.EPSILON);
  assert.ok(result.chunks <= 5);
  return result;
}

const movingFirstUpdate = runMovingUpdate(0.75);
assert.equal(movingFirstUpdate.chunks, 2);
assert.deepEqual(movingFirstUpdate.completedBucketIndices, []);
assert.equal(activeBucketJob?.bucketIndex, 0);
movingDesired = movingSecondDesired;
const movingSecondUpdate = runMovingUpdate();
assert.ok(
  movingSecondUpdate.cancelledBucketIndices.includes(0),
  'new camera selection must cancel stale partial route work',
);
for (let update = 0; update < 32 && movingPending.length > 0; update++) {
  runMovingUpdate();
}
assert.deepEqual(
  movingCurrent,
  movingSecondDesired,
  'moving-camera invalidation must converge to the newest desired selection',
);
assert.deepEqual(movingPending, [], 'settled moving-camera work must reach pending=0');
assert.equal(activeBucketJob, null);
assert.deepEqual(
  [...new Set(publishedBuckets)].sort((left, right) => left - right),
  [1, 2, 3, 4, 5, 6, 7],
  'only buckets dirty in the newest camera selection may publish',
);
assert.deepEqual(cancelledActiveBuckets, [0]);

console.log('test:forest-update-budget passed');

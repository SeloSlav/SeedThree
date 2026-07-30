/**
 * Coalesce an in-flight forest selection update onto the newest desired state
 * and return a deterministic, bounded slice of buckets to upload.
 *
 * Consumers own the buffer-write implementation: after applying
 * `uploadBucketIndices`, pass the returned `pendingBucketIndices` into the next
 * call. A bucket removed from the newest desired diff is dropped immediately,
 * so stale route work never overwrites a newer camera selection.
 */
export function planForestBucketUpdates(
  current,
  desired,
  previousPendingBucketIndices,
  maxBucketUploads,
) {
  const queue = coalesceForestBucketUpdates(
    current,
    desired,
    previousPendingBucketIndices,
  );
  const budget = Number.isFinite(maxBucketUploads)
    ? Math.max(0, Math.floor(maxBucketUploads))
    : queue.pendingBucketIndices.length;
  return {
    uploadBucketIndices: queue.pendingBucketIndices.slice(0, budget),
    pendingBucketIndices: queue.pendingBucketIndices.slice(budget),
  };
}

/**
 * Reconcile an in-flight queue against the newest desired selection.
 *
 * Existing dirty buckets retain their order. Work that is no longer dirty is
 * cancelled immediately, and newly dirty buckets are appended deterministically.
 */
export function coalesceForestBucketUpdates(
  current,
  desired,
  previousPendingBucketIndices,
) {
  const dirty = new Set();
  for (let index = 0; index < desired.length; index += 1) {
    if (!sameSelection(current[index], desired[index])) dirty.add(index);
  }

  const ordered = [];
  const cancelled = [];
  for (const index of previousPendingBucketIndices) {
    if (dirty.delete(index)) {
      ordered.push(index);
    } else {
      cancelled.push(index);
    }
  }
  ordered.push(...[...dirty].sort((left, right) => left - right));

  return {
    pendingBucketIndices: ordered,
    cancelledBucketIndices: cancelled,
  };
}

/**
 * Run resumable bucket work inside both a chunk count and elapsed-time budget.
 *
 * `applyBucketChunk` owns the actual buffer work and receives the hard deadline
 * for this update. It returns `true` (or `{ completed:true }`) only when the
 * current bucket is fully committed. Incomplete work remains first in the queue
 * for the next update, while a newer desired selection is coalesced on every
 * call.
 */
export function runForestBucketUpdateChunk(
  current,
  desired,
  previousPendingBucketIndices,
  options,
) {
  const now = options.now ?? defaultNow;
  const startedAt = now();
  const maxDurationMs = Number.isFinite(options.maxDurationMs)
    ? Math.max(0, options.maxDurationMs)
    : Number.POSITIVE_INFINITY;
  const maxChunks = Number.isFinite(options.maxChunks)
    ? Math.max(0, Math.floor(options.maxChunks))
    : Number.POSITIVE_INFINITY;
  const maxBucketCompletions = Number.isFinite(options.maxBucketCompletions)
    ? Math.max(0, Math.floor(options.maxBucketCompletions))
    : Number.POSITIVE_INFINITY;
  const minimumChunkHeadroomMs = Number.isFinite(options.minimumChunkHeadroomMs)
    ? Math.max(0, options.minimumChunkHeadroomMs)
    : 0;
  const queue = coalesceForestBucketUpdates(
    current,
    desired,
    previousPendingBucketIndices,
  );
  const pending = [...queue.pendingBucketIndices];
  const completedBucketIndices = [];
  let chunks = 0;
  let stopReason = pending.length === 0 ? 'converged' : 'chunk-limit';

  while (pending.length > 0) {
    if (chunks >= maxChunks || completedBucketIndices.length >= maxBucketCompletions) {
      stopReason = 'chunk-limit';
      break;
    }
    const elapsedMs = now() - startedAt;
    if (elapsedMs >= maxDurationMs) {
      stopReason = 'time-limit';
      break;
    }
    if (maxDurationMs - elapsedMs < minimumChunkHeadroomMs) {
      stopReason = 'headroom-limit';
      break;
    }

    const bucketIndex = pending[0];
    const deadlineMs = startedAt + maxDurationMs;
    const result = options.applyBucketChunk(bucketIndex, {
      deadlineMs,
      elapsedMs,
      remainingMs: Math.max(0, maxDurationMs - elapsedMs),
    });
    chunks++;
    const completed = result === true || result?.completed === true;
    if (completed) {
      completedBucketIndices.push(bucketIndex);
      pending.shift();
    }

    if (pending.length === 0) {
      stopReason = 'converged';
      break;
    }
    if (now() - startedAt >= maxDurationMs) {
      stopReason = 'time-limit';
      break;
    }
  }

  return {
    completedBucketIndices,
    pendingBucketIndices: pending,
    cancelledBucketIndices: queue.cancelledBucketIndices,
    chunks,
    durationMs: now() - startedAt,
    stopReason,
  };
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function sameSelection(left, right) {
  return sameIndices(left?.near, right?.near)
    && sameIndices(left?.overview, right?.overview);
}

function sameIndices(left, right) {
  if (!left || !right || left.length !== right.length) return left === right;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

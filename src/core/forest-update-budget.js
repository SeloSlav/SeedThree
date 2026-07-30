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
  const dirty = new Set();
  for (let index = 0; index < desired.length; index += 1) {
    if (!sameSelection(current[index], desired[index])) dirty.add(index);
  }

  const ordered = [];
  for (const index of previousPendingBucketIndices) {
    if (!dirty.delete(index)) continue;
    ordered.push(index);
  }
  ordered.push(...[...dirty].sort((left, right) => left - right));

  const budget = Number.isFinite(maxBucketUploads)
    ? Math.max(0, Math.floor(maxBucketUploads))
    : ordered.length;
  return {
    uploadBucketIndices: ordered.slice(0, budget),
    pendingBucketIndices: ordered.slice(budget),
  };
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

/**
 * Coalesce pending stream slots onto the newest requested world-slot mapping.
 *
 * Existing requests retain their order when still current, new requests are
 * appended by sort key, and superseded requests are reported for cancellation.
 */
export function coalesceStreamSlotRequests(previousPending, newestRequests) {
  const newestBySlot = new Map(newestRequests.map((request) => [request.slotIndex, request]));
  const pending = [];
  const cancelledSlotIndices = [];
  for (const request of previousPending) {
    const newest = newestBySlot.get(request.slotIndex);
    if (!newest) {
      cancelledSlotIndices.push(request.slotIndex);
      continue;
    }
    pending.push(newest);
    newestBySlot.delete(request.slotIndex);
  }
  pending.push(
    ...[...newestBySlot.values()].sort((left, right) => (
      finite(left.sortKey, 0) - finite(right.sortKey, 0)
      || left.slotIndex - right.slotIndex
    )),
  );
  return { pending, cancelledSlotIndices };
}

/**
 * Run resumable stream-slot substeps under elapsed-time and substep budgets.
 *
 * `applySubstep` returns `{ completed, ...telemetry }`. An incomplete request
 * stays first for the next frame; completed requests are removed atomically.
 */
export function runStreamSlotUpdateChunk(pendingRequests, options) {
  const now = options.now ?? defaultNow;
  const startedAt = now();
  const maxDurationMs = Number.isFinite(options.maxDurationMs)
    ? Math.max(0, options.maxDurationMs)
    : Number.POSITIVE_INFINITY;
  const maxSubsteps = Number.isFinite(options.maxSubsteps)
    ? Math.max(0, Math.floor(options.maxSubsteps))
    : Number.POSITIVE_INFINITY;
  const minimumHeadroomMs = Number.isFinite(options.minimumHeadroomMs)
    ? Math.max(0, options.minimumHeadroomMs)
    : 0;
  const pending = [...pendingRequests];
  const completedSlotIndices = [];
  const telemetry = {
    substeps: 0,
    generated: 0,
    cleared: 0,
    written: 0,
    bytesWritten: 0,
  };
  let stopReason = pending.length === 0 ? 'converged' : 'substep-limit';

  while (pending.length > 0 && telemetry.substeps < maxSubsteps) {
    const elapsedMs = now() - startedAt;
    if (elapsedMs >= maxDurationMs) {
      stopReason = 'time-limit';
      break;
    }
    if (maxDurationMs - elapsedMs < minimumHeadroomMs) {
      stopReason = 'headroom-limit';
      break;
    }
    const request = pending[0];
    const result = options.applySubstep(request, {
      deadlineMs: startedAt + maxDurationMs,
      elapsedMs,
      remainingMs: Math.max(0, maxDurationMs - elapsedMs),
    }) ?? {};
    telemetry.substeps++;
    telemetry.generated += finite(result.generated, 0);
    telemetry.cleared += finite(result.cleared, 0);
    telemetry.written += finite(result.written, 0);
    telemetry.bytesWritten += finite(result.bytesWritten, 0);
    if (result.completed === true) {
      completedSlotIndices.push(request.slotIndex);
      pending.shift();
    }
    if (pending.length === 0) {
      stopReason = 'converged';
      break;
    }
  }

  if (pending.length > 0 && telemetry.substeps >= maxSubsteps) {
    stopReason = 'substep-limit';
  }
  return {
    pending,
    completedSlotIndices,
    ...telemetry,
    durationMs: now() - startedAt,
    stopReason,
  };
}

/**
 * Plan merged BufferAttribute update ranges for changed fixed-capacity slots.
 */
export function planSlotAttributeUpdateRanges(
  changedSlotIndices,
  slotCapacity,
  itemSize,
  bytesPerElement = 4,
) {
  const capacity = Math.max(0, Math.floor(slotCapacity));
  const width = Math.max(1, Math.floor(itemSize));
  const ranges = [...new Set(changedSlotIndices)]
    .sort((left, right) => left - right)
    .map((slotIndex) => ({
      start: slotIndex * capacity * width,
      count: capacity * width,
    }));
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && previous.start + previous.count >= range.start) {
      previous.count = Math.max(
        previous.start + previous.count,
        range.start + range.count,
      ) - previous.start;
    } else {
      merged.push({ ...range });
    }
  }
  const componentCount = merged.reduce((sum, range) => sum + range.count, 0);
  return {
    ranges: merged,
    componentCount,
    byteCount: componentCount * Math.max(1, Math.floor(bytesPerElement)),
  };
}

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

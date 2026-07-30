function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
  return value;
}

/**
 * Describes a square stream grid split into fixed-capacity square batches.
 *
 * Edge batches retain the same local capacity as interior batches. This keeps
 * instance offsets stable while a ring-buffered stream moves through world
 * space and lets callers update only the touched batch attributes.
 */
export function createSpatialBatchGridLayout(gridSide, batchSide) {
  const resolvedGridSide = positiveInteger(gridSide, 'gridSide');
  const resolvedBatchSide = positiveInteger(batchSide, 'batchSide');
  const batchGridSide = Math.ceil(resolvedGridSide / resolvedBatchSide);
  return Object.freeze({
    gridSide: resolvedGridSide,
    batchSide: resolvedBatchSide,
    batchGridSide,
    batchCount: batchGridSide * batchGridSide,
    slotsPerBatch: resolvedBatchSide * resolvedBatchSide,
  });
}

/**
 * Maps a row-major stream slot to its stable coarse batch and local slot.
 */
export function locateSpatialBatchSlot(layout, slotIndex) {
  const resolvedSlotIndex = Number(slotIndex);
  const slotCount = layout.gridSide * layout.gridSide;
  if (
    !Number.isInteger(resolvedSlotIndex)
    || resolvedSlotIndex < 0
    || resolvedSlotIndex >= slotCount
  ) {
    throw new RangeError(`slotIndex must be in [0, ${slotCount}).`);
  }

  const gridX = resolvedSlotIndex % layout.gridSide;
  const gridZ = Math.floor(resolvedSlotIndex / layout.gridSide);
  const batchX = Math.floor(gridX / layout.batchSide);
  const batchZ = Math.floor(gridZ / layout.batchSide);
  const localX = gridX % layout.batchSide;
  const localZ = gridZ % layout.batchSide;
  return {
    gridX,
    gridZ,
    batchX,
    batchZ,
    batchIndex: batchZ * layout.batchGridSide + batchX,
    localX,
    localZ,
    localSlotIndex: localZ * layout.batchSide + localX,
  };
}

/**
 * Precomputes the row-major stream slots owned by each batch.
 */
export function collectSpatialBatchSlots(layout) {
  const slotsByBatch = Array.from(
    { length: layout.batchCount },
    () => [],
  );
  const slotCount = layout.gridSide * layout.gridSide;
  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    const location = locateSpatialBatchSlot(layout, slotIndex);
    slotsByBatch[location.batchIndex].push(slotIndex);
  }
  return slotsByBatch;
}

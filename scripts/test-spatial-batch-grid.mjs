import assert from 'node:assert/strict';
import {
  collectSpatialBatchSlots,
  createSpatialBatchGridLayout,
  locateSpatialBatchSlot,
} from '../src/core/spatial-batch-grid.js';

const layout = createSpatialBatchGridLayout(21, 4);
assert.deepEqual(layout, {
  gridSide: 21,
  batchSide: 4,
  batchGridSide: 6,
  batchCount: 36,
  slotsPerBatch: 16,
});

assert.deepEqual(locateSpatialBatchSlot(layout, 0), {
  gridX: 0,
  gridZ: 0,
  batchX: 0,
  batchZ: 0,
  batchIndex: 0,
  localX: 0,
  localZ: 0,
  localSlotIndex: 0,
});
assert.deepEqual(locateSpatialBatchSlot(layout, 20), {
  gridX: 20,
  gridZ: 0,
  batchX: 5,
  batchZ: 0,
  batchIndex: 5,
  localX: 0,
  localZ: 0,
  localSlotIndex: 0,
});
assert.deepEqual(locateSpatialBatchSlot(layout, 440), {
  gridX: 20,
  gridZ: 20,
  batchX: 5,
  batchZ: 5,
  batchIndex: 35,
  localX: 0,
  localZ: 0,
  localSlotIndex: 0,
});

const slotsByBatch = collectSpatialBatchSlots(layout);
assert.equal(slotsByBatch.length, 36);
assert.deepEqual(slotsByBatch[0], [
  0, 1, 2, 3,
  21, 22, 23, 24,
  42, 43, 44, 45,
  63, 64, 65, 66,
]);
assert.deepEqual(slotsByBatch[35], [440]);
assert.equal(
  slotsByBatch.flat().length,
  layout.gridSide * layout.gridSide,
);
assert.equal(new Set(slotsByBatch.flat()).size, 441);

assert.throws(
  () => createSpatialBatchGridLayout(0, 4),
  /gridSide must be a positive integer/,
);
assert.throws(
  () => locateSpatialBatchSlot(layout, 441),
  /slotIndex must be in/,
);

console.log('SeedThree spatial batch grid checks passed.');

import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { createForestEdgeBandReallocation } from '../src/core/forest-edge-band.js';
import {
  createForestLodSelector,
  selectForestLods,
} from '../src/core/forest-lod.js';

const source = Array.from({ length: 420 }, (_, index) => ({
  id: `tree-${index}`,
  x: index % 21 * 9 - 90,
  z: Math.floor(index / 21) * 9 - 90,
  species: index % 3 === 0 ? 'broadleaf' : 'conifer',
}));
const sourceBefore = structuredClone(source);
const edgeSamples = Array.from({ length: 96 }, (_, index) => {
  const angle = index / 96 * Math.PI * 2;
  const radius = 58 + Math.sin(angle * 3) * 7 + Math.sin(angle * 7) * 2.5;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  return {
    x,
    z,
    outwardX: Math.cos(angle),
    outwardZ: Math.sin(angle),
  };
});
const sourceIndices = source
  .map((item, index) => item.species === 'broadleaf' ? index : -1)
  .filter((index) => index >= 0);
sourceIndices.push(
  ...source
    .map((_, index) => index)
    .filter((index) => !sourceIndices.includes(index))
    .slice(0, 256 - sourceIndices.length),
);

const options = {
  targetCount: 256,
  sourceIndices,
  minBandDistance: 12,
  maxBandDistance: 20,
  maxClusterSize: 8,
  clusterTangentSpread: 3.4,
  clusterDepthSpread: 1.2,
  variantCount: 2,
  seed: 'settlement-edge-test',
};
const first = createForestEdgeBandReallocation(source, edgeSamples, options);
const repeat = createForestEdgeBandReallocation(source, edgeSamples, options);

assert.deepEqual(first, repeat, 'edge-band allocation must be deterministic');
assert.deepEqual(source, sourceBefore, 'edge-band allocation must not mutate source slots');
assert.equal(first.items.length, source.length, 'allocation must preserve total slot count');
assert.equal(first.assignments.length, 256, 'allocation must move exactly the requested slots');
assert.equal(first.stats.reallocatedCount, 256);
assert.equal(first.stats.retainedCount, source.length - 256);
assert.equal(first.stats.clusterCount, 32, '256 slots at eight per cluster form 32 clusters');
assert.ok(first.stats.observedMinBandDistance >= 12);
assert.ok(first.stats.observedMaxBandDistance <= 20);

const selected = new Set(first.assignments.map(({ sourceIndex }) => sourceIndex));
assert.equal(selected.size, 256, 'each source slot may be reallocated only once');
for (const assignment of first.assignments) {
  assert.ok(sourceIndices.includes(assignment.sourceIndex));
  assert.ok(assignment.bandDistance >= 12 && assignment.bandDistance <= 20);
  assert.ok(assignment.clusterIndex >= 0 && assignment.clusterIndex < 32);
  assert.equal(first.items[assignment.sourceIndex].x, assignment.x);
  assert.equal(first.items[assignment.sourceIndex].z, assignment.z);
}
assert.equal(
  first.assignments.filter(({ variantIndex }) => variantIndex === 0).length,
  128,
  'two equal-cost variants should split an eight-member cluster evenly',
);
assert.equal(
  first.assignments.filter(({ variantIndex }) => variantIndex === 1).length,
  128,
  'two equal-cost variants should split an eight-member cluster evenly',
);

assert.throws(
  () => createForestEdgeBandReallocation(source, edgeSamples, {
    targetCount: source.length + 1,
  }),
  /requested 421 slots from 420 eligible sources/,
  'the primitive must fail instead of silently growing the slot budget',
);

const overviewSelector = createForestLodSelector([
  { x: 0, y: 0, z: 0, radius: 3, forceOverview: true },
], {
  frustumPadding: 0,
  nearDistance: 100,
});
const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 1000);
camera.position.set(0, 0, 12);
camera.lookAt(new Vector3(0, 0, 0));
camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);
const overviewSelection = selectForestLods(
  overviewSelector,
  camera,
  { force: true },
);
assert.deepEqual(overviewSelection.nearIndices, []);
assert.deepEqual(
  overviewSelection.overviewIndices,
  [0],
  'a reallocated slot capped to overview must reuse the cheaper card rung at close range',
);

console.log('SeedThree forest edge band: deterministic 256-slot reallocation passed.');

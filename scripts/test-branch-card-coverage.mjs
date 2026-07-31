import assert from 'node:assert/strict';
import {
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import {
  BRANCH_CARD_BAKE_REVISION,
  BRANCH_CARD_COVERAGE_DEFAULTS,
  BRANCH_CARD_LIVE_COVERAGE_DEFAULTS,
  buildCardFoliage,
  planBranchCardCoverage,
} from '../src/core/branch-cards.js';
import { Rng } from '../src/core/rng.js';
import { americanBeech } from '../src/species/american-beech.js';
import { apple } from '../src/species/apple.js';
import { cherry } from '../src/species/cherry.js';
import { redMaple } from '../src/species/red-maple.js';
import { sweetgum } from '../src/species/sweetgum.js';
import { tulipPoplar } from '../src/species/tulip-poplar.js';
import { whiteOak } from '../src/species/white-oak.js';

assert.equal(BRANCH_CARD_BAKE_REVISION, 3);

const broadleaves = [
  americanBeech,
  apple,
  cherry,
  redMaple,
  sweetgum,
  tulipPoplar,
  whiteOak,
];
const measurements = [];
for (const species of broadleaves) {
  const first = planBranchCardCoverage(species.foliage, 12);
  const repeat = planBranchCardCoverage(species.foliage, 12);
  assert.deepEqual(first, repeat, `${species.name} coverage planning must be deterministic`);
  assert.equal(first.coverageRequested, 1.5);
  assert.ok(
    first.bakeLeafInstances > first.sourceLeafInstances,
    `${species.name} must add bake-only broadleaf overlap`,
  );
  assert.ok(
    first.extraBakeTriangles <= BRANCH_CARD_COVERAGE_DEFAULTS.extraTriangleBudget,
    `${species.name} fill cohort must fit the temporary triangle budget`,
  );
  assert.equal(first.runtimeCardInstancesAdded, 0);
  assert.equal(species.foliage.cardRadialPlanes, 2);
  assert.equal(species.foliage.mobileNearTwigCollapse, true);
  measurements.push({
    species: species.name,
    baseLeavesPerBranch: first.baseLeavesPerBranch,
    bakedLeavesPerBranch: first.baseLeavesPerBranch + first.extraLeavesPerBranch,
    realizedCoverage: Number(first.coverageRealized.toFixed(3)),
    extraBakeTrianglesAt12Twigs: first.extraBakeTriangles,
  });
}

const compatibility = planBranchCardCoverage({ leavesPerBranch: 7, quads: 2 }, 12);
assert.equal(compatibility.extraLeavesPerBranch, 0, 'coverage remains opt-in');
assert.equal(compatibility.bakeLeafInstances, compatibility.sourceLeafInstances);

const pathological = planBranchCardCoverage(
  { leavesPerBranch: 30, quads: 4, cardCoverage: 99 },
  100,
);
assert.equal(
  pathological.coverageApplied,
  BRANCH_CARD_COVERAGE_DEFAULTS.maxCoverage,
  'coverage requests must be clamped',
);
assert.equal(pathological.budgetLimited, true);
assert.ok(pathological.extraBakeTriangles <= pathological.extraTriangleBudget);
assert.ok(
  pathological.extraBakeTriangles + pathological.trianglesPerLeaf * pathological.terminalStemCount
    > pathological.extraTriangleBudget,
  'the test fixture should exercise the per-branch granularity below the budget ceiling',
);

function makeRuntimeCardSet(capacity) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    -0.5, 0, 0,
    0.5, 0, 0,
    0.5, 1, 0,
    -0.5, 1, 0,
  ]), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute(
    'aWindVec',
    new InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
  );
  geometry.setAttribute(
    'aAnchorPos',
    new InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
  );
  return {
    variants: [{
      geometry,
      material: new MeshBasicNodeMaterial(),
      chordLen: 1,
    }],
    centerUniform: { value: new Vector3() },
    foliageOnly: true,
  };
}

function makeCrossedRuntimeCardSet(capacity) {
  const set = makeRuntimeCardSet(capacity);
  const geometry = set.variants[0].geometry;
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
    0, 0, 0.5, 0, 0, -0.5, 0, 1, -0.5, 0, 1, 0.5,
  ]), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
  ]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1,
  ]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return set;
}

const runtimeStemCount = 20;
const runtimeStems = Array.from({ length: runtimeStemCount }, (_, index) => {
  const base = new Vector3(index % 5, Math.floor(index / 5) * 0.1, index % 3);
  return {
    points: [base, base.clone().add(new Vector3(0, 1 + (index % 4) * 0.05, 0))],
    winds: [0.35, 0.8],
  };
});
const runtimeCards = makeRuntimeCardSet(runtimeStemCount);
const runtimeFoliage = buildCardFoliage(
  runtimeStems,
  runtimeCards,
  new Rng('branch-card-coverage-runtime-count'),
  { growScale: 1, keepFraction: 1 },
);
assert.ok(runtimeFoliage);
const runtimeCardInstances = runtimeFoliage.children.reduce(
  (sum, child) => sum + child.count,
  0,
);
const runtimeCardTriangles = runtimeFoliage.children.reduce(
  (sum, child) => sum + child.count * child.geometry.index.count / 3,
  0,
);
assert.equal(runtimeCardInstances, runtimeStemCount, 'coverage must not multiply runtime cards');
assert.equal(runtimeCardTriangles, runtimeStemCount * 2, 'coverage must not grow runtime triangles');

const crossedRuntimeCards = makeCrossedRuntimeCardSet(runtimeStemCount);
const crossedRuntimeFoliage = buildCardFoliage(
  runtimeStems,
  crossedRuntimeCards,
  new Rng('branch-card-crossed-runtime-count'),
  { growScale: 1, keepFraction: 1, crossed: true },
);
const crossedRuntimeInstances = crossedRuntimeFoliage.children.reduce(
  (sum, child) => sum + child.count,
  0,
);
const crossedRuntimeTriangles = crossedRuntimeFoliage.children.reduce(
  (sum, child) => sum + child.count * child.geometry.index.count / 3,
  0,
);
assert.equal(
  crossedRuntimeInstances,
  runtimeStemCount,
  'two radial planes must stay inside one live card instance',
);
assert.equal(
  crossedRuntimeTriangles,
  runtimeStemCount * 4,
  'two radial planes have an exact four-triangle cost per stem',
);
const crossedWindWeights = crossedRuntimeFoliage.children.flatMap(
  (child) => Array.from(child.userData.windWeights),
);
assert.equal(crossedWindWeights.length, runtimeStemCount);
assert.ok(
  crossedWindWeights.every((weight) => Math.abs(weight - 0.8) < 1e-6),
  'merged crossed limb cards must keep semantic tip wind instead of stiff root wind',
);
assert.equal(BRANCH_CARD_LIVE_COVERAGE_DEFAULTS.maxRadialPlanes, 2);

runtimeCards.variants[0].geometry.dispose();
runtimeCards.variants[0].material.dispose();
crossedRuntimeCards.variants[0].geometry.dispose();
crossedRuntimeCards.variants[0].material.dispose();

console.log('SeedThree branch-card coverage policy tests passed.');
console.table(measurements);
console.log({
  pathologicalExtraBakeTriangles: pathological.extraBakeTriangles,
  extraTriangleBudget: pathological.extraTriangleBudget,
  runtimeCardInstances,
  runtimeCardTriangles,
  crossedRuntimeInstances,
  crossedRuntimeTriangles,
});

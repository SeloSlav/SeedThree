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
  BRANCH_CARD_CROWN_UNDERLAY_DEFAULTS,
  BRANCH_CARD_LIVE_COVERAGE_DEFAULTS,
  buildCardFoliage,
  disposeBranchCards,
  ensureBranchCardCacheEntryAtomic,
  planBranchCardCoverage,
  planBranchCardCrownUnderlay,
  prepareBranchCardFoliageStems,
} from '../src/core/branch-cards.js';
import { Rng } from '../src/core/rng.js';
import { americanBeech } from '../src/species/american-beech.js';
import { apple } from '../src/species/apple.js';
import { cherry } from '../src/species/cherry.js';
import { douglasFir } from '../src/species/douglas-fir.js';
import { loblolly } from '../src/species/loblolly.js';
import { pine } from '../src/species/pine.js';
import { redMaple } from '../src/species/red-maple.js';
import { sweetgum } from '../src/species/sweetgum.js';
import { tulipPoplar } from '../src/species/tulip-poplar.js';
import { whiteOak } from '../src/species/white-oak.js';

assert.equal(BRANCH_CARD_BAKE_REVISION, 4);

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
  const crownUnderlay = planBranchCardCrownUnderlay(
    species.foliage,
    1 + (species.params.baseSplits | 0),
  );
  assert.equal(species.foliage.cardCrownUnderlay, true);
  assert.equal(crownUnderlay.enabled, true);
  assert.equal(crownUnderlay.runtimeTrianglesPerCard, 4);
  assert.equal(crownUnderlay.runtimeDrawsAdded, 1);
  measurements.push({
    species: species.name,
    baseLeavesPerBranch: first.baseLeavesPerBranch,
    bakedLeavesPerBranch: first.baseLeavesPerBranch + first.extraLeavesPerBranch,
    realizedCoverage: Number(first.coverageRealized.toFixed(3)),
    extraBakeTrianglesAt12Twigs: first.extraBakeTriangles,
    crownUnderlayCards: crownUnderlay.rootCardInstances,
    crownUnderlayTriangles: crownUnderlay.runtimeTrianglesAdded,
  });
}

for (const conifer of [douglasFir, loblolly, pine]) {
  const crownUnderlay = planBranchCardCrownUnderlay(conifer.foliage, 1);
  assert.equal(crownUnderlay.enabled, false, `${conifer.name} must retain conifer behavior`);
  assert.equal(crownUnderlay.runtimeTrianglesAdded, 0);
  assert.equal(crownUnderlay.runtimeDrawsAdded, 0);
}

const excessiveRoots = planBranchCardCrownUnderlay({ cardCrownUnderlay: true }, 99);
assert.equal(
  excessiveRoots.rootCardInstances,
  BRANCH_CARD_CROWN_UNDERLAY_DEFAULTS.maxRootCards,
  'whole-crown runtime instances must remain bounded for multi-root inputs',
);
assert.equal(excessiveRoots.runtimeTrianglesAdded, 16);

const laidOutStems = [{
  points: [new Vector3(2, 0, -1), new Vector3(3, 1, -2)],
  orients: [],
}];
const preservedStems = prepareBranchCardFoliageStems(laidOutStems, {
  foliageOnly: true,
  preserveFoliageLayout: true,
});
assert.equal(preservedStems, laidOutStems, 'whole-crown bake must retain subtree layout');
const straightenedStems = prepareBranchCardFoliageStems(laidOutStems, {
  foliageOnly: true,
});
assert.notEqual(straightenedStems, laidOutStems);
assert.deepEqual(
  straightenedStems[0].points.map((point) => [point.x, point.z]),
  [[0, 0], [0, 0]],
  'legacy foliage-only twig bakes must remain axis-straightened',
);
assert.equal(
  Number(straightenedStems[0].points[1].y.toFixed(6)),
  Number(laidOutStems[0].points[1].distanceTo(laidOutStems[0].points[0]).toFixed(6)),
);

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

const underlayRoots = runtimeStems.slice(0, excessiveRoots.rootCardInstances);
const underlayFoliage = buildCardFoliage(
  underlayRoots,
  crossedRuntimeCards,
  new Rng('branch-card-crown-underlay-runtime-count'),
  { growScale: 1, keepFraction: 1, crossed: true },
);
const underlayInstances = underlayFoliage.children.reduce(
  (sum, child) => sum + child.count,
  0,
);
const underlayTriangles = underlayFoliage.children.reduce(
  (sum, child) => sum + child.count * child.geometry.index.count / 3,
  0,
);
assert.equal(underlayInstances, excessiveRoots.rootCardInstances);
assert.equal(underlayTriangles, excessiveRoots.runtimeTrianglesAdded);

const atomicJobs = [
  { level: 2, foliageOnly: true },
  { key: '0:underlay', level: 0, foliageOnly: true },
];
const atomicCache = new Map();
const failedCleanup = { textures: 0, materials: 0, geometries: 0 };
const retryCleanup = { textures: 0, materials: 0, geometries: 0 };
const disposableSet = (counters) => ({
  variants: [{
    textures: Object.fromEntries(
      ['albedo', 'normal', 'rough', 'trans'].map((key) => [key, {
        dispose: () => { counters.textures++; },
      }]),
    ),
    material: { dispose: () => { counters.materials++; } },
    geometry: { dispose: () => { counters.geometries++; } },
  }],
  centerUniform: { value: new Vector3() },
});
const makeAtomicEntry = (byLevel) => {
  const near = byLevel.get('2:fol');
  return near && { byLevel, variants: near.variants, centerUniform: near.centerUniform };
};

let atomicAttempt = 0;
const ensureInjectedAtomicEntry = () => ensureBranchCardCacheEntryAtomic(
  atomicCache,
  'b4:u1',
  atomicJobs,
  async (_job, jobKey) => {
    if (atomicAttempt === 0 && jobKey === '0:underlay') return null;
    return disposableSet(atomicAttempt === 0 ? failedCleanup : retryCleanup);
  },
  makeAtomicEntry,
);
await assert.rejects(
  ensureInjectedAtomicEntry(),
  /0:underlay/,
  'a failed later underlay bake must reject the transaction',
);
assert.equal(atomicCache.size, 0, 'failed atomic sequence must not poison the cache');
assert.deepEqual(
  failedCleanup,
  { textures: 4, materials: 1, geometries: 1 },
  'failure must dispose every resource from the completed near-card set',
);

atomicAttempt++;
const retriedEntry = await ensureInjectedAtomicEntry();
assert.equal(atomicCache.get('b4:u1'), retriedEntry, 'a later call must retry and cache success');
const cachedEntry = await ensureBranchCardCacheEntryAtomic(
  atomicCache,
  'b4:u1',
  atomicJobs,
  async () => { throw new Error('cached entry must not rebake'); },
  makeAtomicEntry,
);
assert.equal(cachedEntry, retriedEntry);
disposeBranchCards(retriedEntry);
assert.deepEqual(
  retryCleanup,
  { textures: 8, materials: 2, geometries: 2 },
  'successful retry must retain both sets until normal cache disposal',
);

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
  underlayInstances,
  underlayTriangles,
});

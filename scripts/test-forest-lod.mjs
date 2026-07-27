import assert from 'node:assert/strict';
import { PerspectiveCamera, StaticDrawUsage, Vector3 } from 'three/webgpu';
import {
  createForestCanopyCompanions,
  createForestLodSelector,
  selectForestLods,
} from '../src/core/forest-lod.js';
import {
  buildForestEdgeEcology,
  createForestEdgeEcology,
} from '../src/core/forest-ecology.js';

function cameraAt(x, y, z, target = new Vector3(0, 0, 0)) {
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 1000);
  camera.position.set(x, y, z);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function assertDisjoint(selection) {
  const near = new Set(selection.nearIndices);
  for (const index of selection.overviewIndices) {
    assert.ok(!near.has(index), `tree ${index} must not render in both LOD bands`);
  }
  assert.equal(
    selection.visibleCount,
    selection.nearIndices.length + selection.overviewIndices.length,
    'visible count should be the disjoint union of near and overview trees',
  );
}

{
  const items = [
    { x: 0, y: 8, z: 0, radius: 10 },
    { x: 130, y: 8, z: 0, radius: 10 },
    { x: 0, y: 8, z: 145, radius: 10 },
  ];
  const selector = createForestLodSelector(items, {
    frustumPadding: 0,
    nearDistance: 100,
    lodHysteresis: 8,
    minimumCameraMove: 2,
    minimumDirectionAngle: Math.PI / 180,
  });
  const camera = cameraAt(0, 24, 90, new Vector3(0, 8, 0));
  const first = selectForestLods(selector, camera, { force: true });
  assertDisjoint(first);
  assert.ok(first.nearIndices.includes(0), 'front tree should remain in the close-detail rung');
  assert.ok(first.viewIndices.includes(0), 'front tree should be part of the main-view selection');
  assert.ok(!first.nearIndices.includes(2) && !first.overviewIndices.includes(2),
    'tree behind the camera should be culled');
  assert.ok(!first.nearIndices.includes(1) && !first.overviewIndices.includes(1),
    'unpadded side tree should be outside the main frustum');

  const withCasterBand = selectForestLods(selector, camera, {
    force: true,
    casterBounds: { minX: 118, maxX: 142, minZ: -14, maxZ: 14 },
    casterPadding: 0,
  });
  assertDisjoint(withCasterBand);
  assert.ok(withCasterBand.overviewIndices.includes(1),
    'off-screen tree intersecting the fitted shadow caster band must remain submitted');
  assert.ok(!withCasterBand.viewIndices.includes(1),
    'shadow-only caster must not seed render-only canopy companions');
  assert.ok(!withCasterBand.nearIndices.includes(2) && !withCasterBand.overviewIndices.includes(2),
    'caster union must not revive unrelated behind-camera trees');

  const revision = withCasterBand.revision;
  const stable = selectForestLods(selector, camera, {
    casterBounds: { minX: 118, maxX: 142, minZ: -14, maxZ: 14 },
    casterPadding: 0,
  });
  assert.equal(stable.skipped, true, 'static camera should not rebuild compact instance buffers');
  assert.equal(stable.revision, revision, 'static query should not advance the selection revision');

  const policyChange = selectForestLods(selector, camera, {
    casterBounds: { minX: 118, maxX: 142, minZ: -14, maxZ: 14 },
    casterPadding: 0,
    frustumPadding: 16,
  });
  assert.equal(policyChange.skipped, false,
    'a visibility-padding change must invalidate the static-camera selection');
}

{
  const selector = createForestLodSelector([
    { x: 0, y: 0, z: 0, radius: 3 },
  ], {
    frustumPadding: 0,
    nearDistance: 100,
    lodHysteresis: 10,
    minimumCameraMove: 0,
  });
  const first = selectForestLods(selector, cameraAt(0, 0, 100), { force: true });
  assert.deepEqual(first.nearIndices, [0], 'tree at the nominal boundary begins in near LOD');

  const withinExitBand = selectForestLods(selector, cameraAt(0, 0, 108), { force: true });
  assert.deepEqual(withinExitBand.nearIndices, [0],
    'near tree stays near inside the hysteresis exit band');

  const beyondExitBand = selectForestLods(selector, cameraAt(0, 0, 112), { force: true });
  assert.deepEqual(beyondExitBand.overviewIndices, [0],
    'near tree changes to overview only beyond the exit band');

  const withinEnterBand = selectForestLods(selector, cameraAt(0, 0, 94), { force: true });
  assert.deepEqual(withinEnterBand.overviewIndices, [0],
    'overview tree stays overview inside the hysteresis enter band');

  const beyondEnterBand = selectForestLods(selector, cameraAt(0, 0, 88), { force: true });
  assert.deepEqual(beyondEnterBand.nearIndices, [0],
    'overview tree returns near only after crossing the enter band');
}

{
  const selector = createForestLodSelector([
    { x: 0, y: 0, z: -200, radius: 1 },
  ], { frustumPadding: 0 });
  const empty = selectForestLods(
    selector,
    cameraAt(0, 0, 10, new Vector3(0, 0, 20)),
  );
  assert.equal(empty.visibleCount, 0);
  assert.equal(empty.changed, true,
    'the first completed selection must clear initially populated render buffers');
  assert.equal(empty.revision, 1);
}

{
  const source = [
    { x: 0, y: 8, z: 0, radius: 6 },
    { x: 11, y: 7, z: 1, radius: 5 },
    { x: -9, y: 9, z: 5, radius: 7 },
    { x: 3, y: 6, z: -12, radius: 5 },
    { x: 150, y: 8, z: 150, radius: 6 },
  ];
  const before = structuredClone(source);
  const options = {
    neighborRadius: 30,
    maxCompanions: 2,
    denseNeighborCount: 3,
    minOffset: 3,
    maxOffset: 7,
    minScale: 0.28,
    maxScale: 0.44,
  };
  const first = createForestCanopyCompanions(source, options);
  const repeat = createForestCanopyCompanions(source, options);
  assert.deepEqual(first, repeat, 'canopy companions must be deterministic');
  assert.deepEqual(source, before, 'companion derivation must not mutate gameplay sources');
  assert.equal(first.length, source.length, 'companion lists preserve source index identity');
  assert.equal(first[4].length, 0, 'isolated trees must not expand forest into open ground');
  assert.equal(first[0].length, 2, 'dense forest anchors may receive two understorey crowns');
  for (const list of first) {
    assert.ok(list.length <= 2, 'companion count must remain strictly bounded');
    for (const companion of list) {
      const offset = Math.hypot(companion.offsetX, companion.offsetZ);
      assert.ok(offset >= 1.35 && offset <= 7.1,
        'companion must remain within its source-to-neighbor corridor');
      assert.ok(companion.scale >= 0.28 && companion.scale <= 0.44,
        'companion scale must stay in the configured understorey band');
    }
  }
}

{
  const source = [];
  for (let ring = 0; ring < 4; ring++) {
    const radius = 58 + ring * 12;
    for (let index = 0; index < 18; index++) {
      const angle = index / 18 * Math.PI * 2 + ring * 0.08;
      source.push({
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius,
      });
    }
  }
  source.push({ x: 12, z: 4 });
  source.push({ x: 260, z: 260 });
  const before = structuredClone(source);
  const blocked = (x, z) => x > 50 && z > -8 && z < 8;
  const options = {
    protectedRadius: 50,
    outerRadius: 125,
    neighborRadius: 28,
    minimumNeighbors: 2,
    minimumAnchorSpacing: 8,
    edgeBandWidth: 42,
    maxAnchors: 32,
    maxSaplings: 24,
    maxUnderstory: 48,
    maxDeadwood: 10,
    maxLitter: 48,
    isBlockedAt: blocked,
  };
  const first = createForestEdgeEcology(source, options);
  const repeat = createForestEdgeEcology(source, options);
  assert.deepEqual(first, repeat, 'clearing-edge ecology must be deterministic');
  assert.deepEqual(source, before, 'ecology derivation must not mutate gameplay sources');
  assert.ok(first.anchorCount <= 32, 'anchor count must respect its hard cap');
  assert.ok(first.saplings.length <= 24, 'saplings must respect their hard cap');
  assert.ok(first.understory.length <= 48, 'understory must respect its hard cap');
  assert.ok(first.deadwood.length <= 10, 'deadwood must respect its hard cap');
  assert.ok(first.litter.length <= 48, 'litter must respect its hard cap');
  for (const kind of ['saplings', 'understory', 'deadwood', 'litter']) {
    for (const placement of first[kind]) {
      assert.ok(Math.hypot(placement.x, placement.z) >= 50,
        `${kind} must not enter the protected meadow`);
      assert.ok(!blocked(placement.x, placement.z),
        `${kind} must respect consumer blocked-area exclusions`);
      assert.ok(Number.isInteger(placement.sourceIndex),
        `${kind} keeps source provenance without becoming a gameplay tree`);
    }
  }
  for (const kind of ['saplings', 'understory', 'deadwood', 'litter']) {
    const innerEdgeMembers = first[kind].filter(
      (placement) => Math.hypot(placement.x, placement.z) <= 104,
    );
    assert.ok(
      innerEdgeMembers.length >= Math.floor(first[kind].length * 0.72),
      `${kind} must compose primarily inside the visible clearing-edge band`,
    );
  }

  const layer = buildForestEdgeEcology(first, {
    getHeightAt: (x, z) => x * 0.001 - z * 0.002,
  });
  assert.equal(layer.stats.draws, 5, 'all ecology renders in five static instance batches');
  assert.equal(
    layer.stats.instances,
    first.saplings.length * 2
      + first.understory.length
      + first.deadwood.length
      + first.litter.length,
    'structural stats include the two sapling batches and every ecology instance',
  );
  const saplingCrowns = layer.group.getObjectByName(
    'SeedThree ecology clustered sapling crowns',
  );
  assert.ok(saplingCrowns?.isInstancedMesh,
    'young-fir crowns remain one instanced draw');
  assert.equal(
    saplingCrowns.geometry.index.count / 3,
    40,
    'young-fir crowns use three asymmetric low-sided tiers instead of one cone',
  );
  assert.ok(layer.stats.triangles > 0 && layer.stats.triangles < 20_000,
    'the complete edge ecology must remain a low-triangle overlay');
  layer.group.traverse((object) => {
    if (!object.isInstancedMesh) return;
    assert.equal(object.instanceMatrix.usage, StaticDrawUsage,
      'ecology matrices remain static and require no per-frame uploads');
    assert.equal(object.userData.neverCastShadow, true,
      'edge companions never enlarge the directional shadow workload');
  });
  assert.ok(
    layer.group.getObjectByName('SeedThree ecology meadow-edge herb clumps'),
    'the fifth static ecology batch must provide a raised meadow-edge silhouette',
  );
  layer.dispose();
}

console.log('SeedThree forest LOD: culling, caster union, stability, and hysteresis passed.');

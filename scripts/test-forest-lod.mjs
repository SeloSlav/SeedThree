import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import {
  createForestLodSelector,
  selectForestLods,
} from '../src/core/forest-lod.js';
import {
  branchCardExemplarQuantiles,
  clampBranchCardScale,
} from '../src/core/branch-cards.js';

function cameraAt(x, y, z, target = new Vector3(0, 0, 0)) {
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 1000);
  camera.position.set(x, y, z);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
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
  assert.ok(first.nearIndices.includes(0), 'front tree should remain in the close-detail rung');
  assert.ok(!first.nearIndices.includes(2) && !first.overviewIndices.includes(2),
    'tree behind the camera should be culled');
  assert.ok(!first.nearIndices.includes(1) && !first.overviewIndices.includes(1),
    'unpadded side tree should be outside the main frustum');

  const withCasterBand = selectForestLods(selector, camera, {
    force: true,
    casterBounds: { minX: 118, maxX: 142, minZ: -14, maxZ: 14 },
    casterPadding: 0,
  });
  assert.ok(withCasterBand.overviewIndices.includes(1),
    'off-screen tree intersecting the fitted shadow caster band must remain submitted');
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
  assert.deepEqual(branchCardExemplarQuantiles(3), [0.18, 0.5, 0.82],
    'three overview exemplars must span both tails of the limb-size distribution');
  assert.deepEqual(branchCardExemplarQuantiles(20), [0.12, 0.37, 0.63, 0.88],
    'the fixed atlas budget must cap excessive variant requests');
  assert.equal(clampBranchCardScale(5, false, true), 1.85,
    'crossed overview cards must reject pathological scale outliers');
  assert.equal(clampBranchCardScale(0.1, false, true), 0.55);
  assert.equal(clampBranchCardScale(5, true, false), 1.15,
    'foliage-only cards retain their tighter leaf-size range');
  assert.equal(clampBranchCardScale(2.4, false, false), 2.4,
    'uncrossed full-content cards retain their authored scale');
}

console.log('SeedThree forest LOD: culling, caster union, hysteresis, and overview card bounds passed.');

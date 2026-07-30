import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import {
  createForestLodSelector,
  selectForestLods,
} from '../src/core/forest-lod.js';

const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 1000);
camera.position.set(0, 18, 90);
camera.lookAt(new Vector3(0, 8, 0));
camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);

const selector = createForestLodSelector([
  { x: 0, y: 8, z: 0, radius: 10 },
  { x: 45, y: 8, z: -20, radius: 8 },
], {
  frustumPadding: 24,
  nearDistance: 108,
  minimumCameraMove: 8,
  minimumDirectionAngle: 2.5 * Math.PI / 180,
  minimumProjectionChange: 0.005,
  minimumCasterBoundsChange: 0.75,
});

const initial = selectForestLods(selector, camera);
assert.deepEqual(initial.triggerReasons, ['initial']);
assert.equal(initial.skipped, false);

let projectionEvaluations = 0;
let projectionSkips = 0;
for (let frame = 1; frame <= 120; frame += 1) {
  camera.fov = 50 + 0.2 * frame / 120;
  camera.updateProjectionMatrix();
  const selection = selectForestLods(selector, camera);
  if (selection.skipped) {
    projectionSkips++;
  } else {
    projectionEvaluations++;
    assert.deepEqual(
      selection.triggerReasons,
      ['projection-envelope'],
      'continuous FOV interpolation must invalidate only at the accumulated envelope',
    );
  }
}
assert.ok(
  projectionSkips >= 116,
  `tiny per-frame FOV coefficient changes should mostly skip (${projectionSkips}/120)`,
);
assert.ok(
  projectionEvaluations >= 1 && projectionEvaluations <= 4,
  `accumulated FOV drift should still invalidate conservatively (${projectionEvaluations})`,
);

const casterBase = { minX: -30, maxX: 30, minZ: -20, maxZ: 20 };
const casterInitial = selectForestLods(selector, camera, {
  casterBounds: casterBase,
});
assert.deepEqual(casterInitial.triggerReasons, ['caster-bounds-envelope']);

let casterEvaluations = 0;
for (let frame = 1; frame <= 60; frame += 1) {
  const drift = frame * 0.02;
  const selection = selectForestLods(selector, camera, {
    casterBounds: {
      minX: casterBase.minX + drift,
      maxX: casterBase.maxX + drift,
      minZ: casterBase.minZ,
      maxZ: casterBase.maxZ,
    },
  });
  if (!selection.skipped) {
    casterEvaluations++;
    assert.deepEqual(selection.triggerReasons, ['caster-bounds-envelope']);
  }
}
assert.ok(
  casterEvaluations >= 1 && casterEvaluations <= 2,
  `continuous caster-bound drift should use its accumulated envelope (${casterEvaluations})`,
);

camera.position.x += 8.1;
camera.updateMatrixWorld(true);
const moved = selectForestLods(selector, camera, {
  casterBounds: {
    minX: casterBase.minX + 1.2,
    maxX: casterBase.maxX + 1.2,
    minZ: casterBase.minZ,
    maxZ: casterBase.maxZ,
  },
});
assert.deepEqual(moved.triggerReasons, ['camera-moved']);

const forced = selectForestLods(selector, camera, {
  force: true,
  casterBounds: {
    minX: casterBase.minX + 1.2,
    maxX: casterBase.maxX + 1.2,
    minZ: casterBase.minZ,
    maxZ: casterBase.maxZ,
  },
});
assert.deepEqual(forced.triggerReasons, ['force']);
assert.equal(
  selector.telemetry.calls,
  selector.telemetry.evaluations + selector.telemetry.skips,
);
assert.equal(
  selector.telemetry.triggerReasons['projection-envelope'],
  projectionEvaluations,
);
assert.equal(
  selector.telemetry.triggerReasons['caster-bounds-envelope'],
  casterEvaluations + 1,
);
assert.deepEqual(selector.telemetry.lastTriggerReasons, ['force']);

console.log('test:forest-invalidation passed');

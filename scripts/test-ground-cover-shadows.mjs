import assert from 'node:assert/strict';
import {
  applyGroundCoverShadowPolicy,
  resolveGroundCoverShadowPolicy,
} from '../src/core/ground-cover-shadows.js';

assert.deepEqual(resolveGroundCoverShadowPolicy(), {
  castShadow: false,
  receiveShadow: false,
  mode: 'terrain-projected',
});
assert.deepEqual(
  resolveGroundCoverShadowPolicy({ terrainReceivesShadow: false }),
  {
    castShadow: false,
    receiveShadow: true,
    mode: 'mesh-received',
  },
);
assert.deepEqual(
  resolveGroundCoverShadowPolicy({
    castShadow: true,
    receiveShadow: true,
  }),
  {
    castShadow: true,
    receiveShadow: true,
    mode: 'mesh-received',
  },
);
assert.throws(
  () => resolveGroundCoverShadowPolicy({ receiveShadow: 'sometimes' }),
  /true, false, or "auto"/,
);

const mesh = {
  castShadow: true,
  receiveShadow: true,
  userData: {},
};
const policy = applyGroundCoverShadowPolicy(mesh, {
  terrainReceivesShadow: true,
});
assert.equal(mesh.castShadow, false);
assert.equal(mesh.receiveShadow, false);
assert.equal(mesh.userData.groundCoverShadowPolicy, 'terrain-projected');
assert.equal(policy.mode, 'terrain-projected');

console.log('SeedThree ground-cover shadow policy tests passed.');

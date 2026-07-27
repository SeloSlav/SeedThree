import assert from 'node:assert/strict';
import {
  InstancedBufferAttribute,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { buildCardFoliage } from '../src/core/branch-cards.js';
import { Rng } from '../src/core/rng.js';

const geometry = new PlaneGeometry(1, 1);
geometry.setAttribute(
  'aWindVec',
  new InstancedBufferAttribute(new Float32Array(12), 3),
);
geometry.setAttribute(
  'aAnchorPos',
  new InstancedBufferAttribute(new Float32Array(12), 3),
);

const cards = {
  foliageOnly: false,
  centerUniform: { value: new Vector3() },
  variants: [{
    geometry,
    material: new MeshBasicMaterial(),
    chordLen: 1,
  }],
};
const stem = (length) => ({
  points: [new Vector3(0, 0, 0), new Vector3(0, length, 0)],
  winds: [0.2, 0.8],
});
const foliage = buildCardFoliage(
  [stem(0.1), stem(10)],
  cards,
  new Rng('overview-card-clamp'),
  { crossed: true, growScale: 1 },
);
assert.ok(foliage, 'crossed overview foliage should be constructed');
const mesh = foliage.children[0];
assert.equal(mesh.count, 4, 'two limbs should produce two crossed cards each');

const matrix = new Matrix4();
const position = new Vector3();
const rotation = new Quaternion();
const scale = new Vector3();
const scales = [];
for (let index = 0; index < mesh.count; index++) {
  mesh.getMatrixAt(index, matrix);
  matrix.decompose(position, rotation, scale);
  scales.push(scale.x);
}
assert.ok(Math.min(...scales) >= 0.55 - 1e-6,
  'whole-limb card scale should keep a conservative lower silhouette bound');
assert.ok(Math.max(...scales) <= 1.85 + 1e-6,
  'whole-limb outlier must never become a screen-sized overview quad');

geometry.dispose();
cards.variants[0].material.dispose();
console.log('SeedThree overview branch cards: crossed-card scale safety passed.');

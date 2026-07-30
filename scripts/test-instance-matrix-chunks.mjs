import assert from 'node:assert/strict';
import {
  BoxGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
} from 'three/webgpu';
import {
  createInstanceMatrixWriteJob,
  runInstanceMatrixWriteChunk,
} from '../src/core/instance-matrix-chunks.js';

function makeLodSet(capacity) {
  const branchGeometry = new BoxGeometry(1, 1, 1);
  branchGeometry.setAttribute(
    'aWindVec',
    new InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
  );
  branchGeometry.setAttribute(
    'aAnchorPos',
    new InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
  );
  const branches = new InstancedMesh(
    branchGeometry,
    new MeshBasicMaterial(),
    capacity,
  );

  const cardGeometry = new PlaneGeometry(1, 1);
  cardGeometry.setAttribute(
    'aTreeOrigin',
    new InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
  );
  cardGeometry.setAttribute(
    'aWindVec',
    new InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
  );
  cardGeometry.setAttribute(
    'aAnchorPos',
    new InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
  );
  const cards = new InstancedMesh(
    cardGeometry,
    new MeshBasicMaterial(),
    capacity,
  );
  cards.userData.k = 1;
  cards.userData.srcMatrices = new Float32Array(new Matrix4().elements);
  cards.userData.weights = new Float32Array([0.75]);
  return { branches, cards: [cards] };
}

const slots = [
  {
    matrix: new Matrix4().makeTranslation(10, 0, 0),
    pos: new Vector3(10, 4, 0),
    enabled: true,
    tagged: true,
  },
  {
    matrix: new Matrix4().makeTranslation(20, 0, 0),
    pos: new Vector3(20, 5, 0),
    enabled: true,
    tagged: false,
  },
];
const near = makeLodSet(2);
const overview = makeLodSet(2);
near.branches.count = 1;
near.cards[0].count = 1;
overview.branches.count = 1;
overview.cards[0].count = 1;
const branchVersionBefore = near.branches.instanceMatrix.version;
const anchorVersionBefore = near.branches.geometry.attributes.aAnchorPos.version;

const job = createInstanceMatrixWriteJob(
  near,
  overview,
  slots,
  [0, 1],
  [],
  {
    resolveTreeOriginY: (slot) => slot.pos.y + (slot.tagged ? 100 : 0),
  },
);
const first = runInstanceMatrixWriteChunk(job, {
  deadlineMs: Number.POSITIVE_INFINITY,
  maxMatrixWrites: 1,
});
assert.equal(first.completed, false);
assert.equal(first.matrixWrites, 1);
assert.equal(near.branches.count, 1, 'partial CPU writes must not change live counts');
assert.equal(overview.branches.count, 1, 'near/overview counts commit atomically');
assert.equal(near.branches.instanceMatrix.version, branchVersionBefore);
assert.equal(near.branches.geometry.attributes.aAnchorPos.version, anchorVersionBefore);

let calls = 1;
while (!job.completed && calls < 16) {
  runInstanceMatrixWriteChunk(job, {
    deadlineMs: Number.POSITIVE_INFINITY,
    maxMatrixWrites: 1,
  });
  calls++;
}
assert.equal(job.completed, true);
assert.ok(calls > 1, 'a real branch/card bucket must span bounded chunks');
assert.equal(near.branches.count, 2);
assert.equal(near.cards[0].count, 2);
assert.equal(overview.branches.count, 0);
assert.equal(overview.cards[0].count, 0);
assert.ok(near.branches.instanceMatrix.version > branchVersionBefore);
assert.ok(near.branches.geometry.attributes.aAnchorPos.version > anchorVersionBefore);

const matrix = new Matrix4();
near.branches.getMatrixAt(1, matrix);
assert.equal(matrix.elements[12], 20, 'branch transform buffer must preserve slot matrices');
const treeOrigin = near.cards[0].geometry.attributes.aTreeOrigin;
assert.equal(treeOrigin.getY(0), 104, 'consumer metadata callback must populate card attributes');
assert.equal(treeOrigin.getY(1), 5);
assert.equal(near.cards[0].geometry.attributes.aWindVec.getY(0), 0.75);

for (const set of [near, overview]) {
  set.branches.geometry.dispose();
  set.branches.material.dispose();
  for (const mesh of set.cards) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}

console.log('test:instance-matrix-chunks passed');

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
  DEFAULT_INSTANCE_MATRIX_DEADLINE_CHECK_INTERVAL,
  DEFAULT_INSTANCE_MATRIX_WRITES_PER_CHUNK,
  createInstanceMatrixWriteJob,
  runInstanceMatrixWriteChunk,
  runInstanceMatrixWriteSlices,
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

const slicedSlots = Array.from(
  { length: DEFAULT_INSTANCE_MATRIX_WRITES_PER_CHUNK + 1 },
  (_, index) => ({
    matrix: new Matrix4().makeTranslation(index, 0, 0),
    pos: new Vector3(index, 0, 0),
    enabled: true,
  }),
);
const slicedNear = makeLodSet(slicedSlots.length);
const slicedOverview = makeLodSet(slicedSlots.length);
slicedNear.branches.count = 11;
slicedNear.cards[0].count = 11;
slicedOverview.branches.count = 5;
slicedOverview.cards[0].count = 5;
const slicedJob = createInstanceMatrixWriteJob(
  slicedNear,
  slicedOverview,
  slicedSlots,
  slicedSlots.map((_, index) => index),
  [],
);
const defaultSlice = runInstanceMatrixWriteChunk(slicedJob, {
  deadlineMs: Number.POSITIVE_INFINITY,
});
assert.equal(
  defaultSlice.matrixWrites,
  DEFAULT_INSTANCE_MATRIX_WRITES_PER_CHUNK,
  'the reusable default must bound one matrix-write slice',
);
assert.equal(defaultSlice.completed, false);
assert.equal(
  slicedNear.branches.count,
  11,
  'an incomplete default slice must retain the previous live count',
);
assert.equal(slicedNear.cards[0].count, 11);
assert.equal(slicedOverview.branches.count, 5);
assert.equal(slicedOverview.cards[0].count, 5);
let defaultSliceCalls = 1;
while (!slicedJob.completed && defaultSliceCalls < 8) {
  runInstanceMatrixWriteChunk(slicedJob, {
    deadlineMs: Number.POSITIVE_INFINITY,
  });
  defaultSliceCalls++;
}
assert.equal(slicedJob.completed, true, 'default slices must converge');
assert.equal(defaultSliceCalls, 3);
assert.equal(slicedNear.branches.count, slicedSlots.length);
assert.equal(slicedNear.cards[0].count, slicedSlots.length);
assert.equal(slicedOverview.branches.count, 0);
assert.equal(slicedOverview.cards[0].count, 0);
const slicedLastMatrix = new Matrix4();
slicedNear.cards[0].getMatrixAt(slicedSlots.length - 1, slicedLastMatrix);
assert.equal(
  slicedLastMatrix.elements[12],
  slicedSlots.length - 1,
  'default slices must preserve deterministic matrix output',
);

const deadlineSlotCount = DEFAULT_INSTANCE_MATRIX_DEADLINE_CHECK_INTERVAL + 16;
const deadlineNear = makeLodSet(deadlineSlotCount);
const deadlineOverview = makeLodSet(deadlineSlotCount);
deadlineNear.branches.count = 7;
deadlineNear.cards[0].count = 7;
deadlineOverview.branches.count = 3;
deadlineOverview.cards[0].count = 3;
const deadlineSlots = Array.from({ length: deadlineSlotCount }, (_, index) => ({
  matrix: new Matrix4().makeTranslation(index, 0, 0),
  pos: new Vector3(index, 0, 0),
  enabled: true,
}));
const deadlineJob = createInstanceMatrixWriteJob(
  deadlineNear,
  deadlineOverview,
  deadlineSlots,
  deadlineSlots.map((_, index) => index),
  [],
);
let deadlineNowMs = 0;
const deadlineSlice = runInstanceMatrixWriteChunk(deadlineJob, {
  deadlineMs: 0.5,
  now: () => {
    const sampled = deadlineNowMs;
    deadlineNowMs += 0.3;
    return sampled;
  },
});
assert.equal(
  deadlineSlice.matrixWrites,
  DEFAULT_INSTANCE_MATRIX_DEADLINE_CHECK_INTERVAL * 2,
  'the default deadline cadence must yield within two fine polling intervals',
);
assert.equal(deadlineSlice.completed, false);
assert.equal(
  deadlineNear.branches.count,
  7,
  'deadline-yielded CPU writes must not become partially visible',
);

const multiSliceSlots = Array.from({ length: 193 }, (_, index) => ({
  matrix: new Matrix4().makeTranslation(index, index % 7, 0),
  pos: new Vector3(index, index % 7, 0),
  enabled: true,
}));
const multiSliceNear = makeLodSet(multiSliceSlots.length);
const multiSliceOverview = makeLodSet(multiSliceSlots.length);
multiSliceNear.branches.count = 9;
multiSliceNear.cards[0].count = 9;
multiSliceOverview.branches.count = 4;
multiSliceOverview.cards[0].count = 4;
const multiSliceJob = createInstanceMatrixWriteJob(
  multiSliceNear,
  multiSliceOverview,
  multiSliceSlots,
  multiSliceSlots.map((_, index) => index),
  [],
);
let multiSliceNowMs = 0;
const multiSliceResult = runInstanceMatrixWriteSlices(multiSliceJob, {
  deadlineMs: 10,
  minimumChunkHeadroomMs: 0.1,
  maxMatrixWritesPerChunk: 128,
  now: () => {
    const sampled = multiSliceNowMs;
    multiSliceNowMs += 0.005;
    return sampled;
  },
});
assert.equal(multiSliceResult.completed, true);
assert.equal(multiSliceResult.stopReason, 'converged');
assert.equal(multiSliceResult.chunks, 4);
assert.equal(multiSliceResult.matrixWrites, multiSliceSlots.length * 2);
assert.equal(
  multiSliceResult.maxMatrixWritesInChunk,
  128,
  'every fine matrix slice must retain the configured preemption bound',
);
assert.ok(
  multiSliceResult.durationMs < 10,
  'multiple fine chunks must converge before the hard deadline',
);
assert.equal(multiSliceNear.branches.count, multiSliceSlots.length);
assert.equal(multiSliceNear.cards[0].count, multiSliceSlots.length);
assert.equal(multiSliceOverview.branches.count, 0);
assert.equal(multiSliceOverview.cards[0].count, 0);
const multiSliceLastMatrix = new Matrix4();
multiSliceNear.cards[0].getMatrixAt(
  multiSliceSlots.length - 1,
  multiSliceLastMatrix,
);
assert.equal(multiSliceLastMatrix.elements[12], multiSliceSlots.length - 1);

const headroomSlots = Array.from({ length: 257 }, (_, index) => ({
  matrix: new Matrix4().makeTranslation(index, 0, 0),
  pos: new Vector3(index, 0, 0),
  enabled: true,
}));
const headroomNear = makeLodSet(headroomSlots.length);
const headroomOverview = makeLodSet(headroomSlots.length);
headroomNear.branches.count = 13;
headroomNear.cards[0].count = 13;
const headroomJob = createInstanceMatrixWriteJob(
  headroomNear,
  headroomOverview,
  headroomSlots,
  headroomSlots.map((_, index) => index),
  [],
);
let headroomSample = 0;
const headroomResult = runInstanceMatrixWriteSlices(headroomJob, {
  deadlineMs: 1,
  minimumChunkHeadroomMs: 0.2,
  maxMatrixWritesPerChunk: 128,
  deadlineCheckInterval: 1,
  now: () => {
    headroomSample++;
    return headroomSample < 36 ? 0 : 0.85;
  },
});
assert.equal(headroomResult.completed, false);
assert.equal(headroomResult.stopReason, 'headroom-limit');
assert.equal(headroomResult.chunks, 1);
assert.equal(headroomResult.matrixWrites, 128);
assert.equal(headroomResult.maxMatrixWritesInChunk, 128);
assert.ok(headroomResult.durationMs <= 1);
assert.equal(
  headroomNear.branches.count,
  13,
  'headroom stop must leave live counts at the previous atomic publication',
);
assert.equal(headroomNear.cards[0].count, 13);

for (const set of [
  near,
  overview,
  slicedNear,
  slicedOverview,
  deadlineNear,
  deadlineOverview,
  multiSliceNear,
  multiSliceOverview,
  headroomNear,
  headroomOverview,
]) {
  set.branches.geometry.dispose();
  set.branches.material.dispose();
  for (const mesh of set.cards) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}

console.log('test:instance-matrix-chunks passed');

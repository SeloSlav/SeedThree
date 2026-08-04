export const DEFAULT_INSTANCE_MATRIX_WRITES_PER_CHUNK = 256;
export const DEFAULT_INSTANCE_MATRIX_DEADLINE_CHECK_INTERVAL = 64;

/**
 * Create an atomic, resumable branch/card instance compaction job.
 *
 * The default slot contract is deliberately small: `{ matrix, pos, enabled }`.
 * Consumers can provide `isSlotVisible` and `resolveTreeOriginY` when gameplay
 * visibility or packed per-tree metadata differs. CPU buffers are written in
 * chunks, while mesh counts and GPU upload flags remain untouched until every
 * near/overview task is complete.
 */
export function createInstanceMatrixWriteJob(
  nearSet,
  overviewSet,
  slots,
  nearSlotIndices,
  overviewSlotIndices,
  options = {},
) {
  return {
    tasks: [
      ...createMatrixWriteTasks(nearSet, slots, nearSlotIndices),
      ...createMatrixWriteTasks(overviewSet, slots, overviewSlotIndices),
    ],
    taskIndex: 0,
    completed: false,
    writeWindYOnly: options.windXZInitializedZero === true,
    isSlotVisible: options.isSlotVisible ?? defaultSlotVisible,
    resolveTreeOriginY: options.resolveTreeOriginY ?? ((slot) => slot.pos.y),
  };
}

export function runInstanceMatrixWriteChunk(
  job,
  options,
) {
  const now = options.now ?? defaultNow;
  const startedAt = now();
  const maxMatrixWrites = options.maxMatrixWrites === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Number.isFinite(options.maxMatrixWrites)
      ? Math.max(1, Math.floor(options.maxMatrixWrites))
      : DEFAULT_INSTANCE_MATRIX_WRITES_PER_CHUNK;
  const deadlineCheckInterval = Number.isFinite(options.deadlineCheckInterval)
    ? Math.max(1, Math.floor(options.deadlineCheckInterval))
    : DEFAULT_INSTANCE_MATRIX_DEADLINE_CHECK_INTERVAL;
  const hasDeadline = Number.isFinite(options.deadlineMs);
  let matrixWrites = 0;
  let workUnits = 0;
  let deadlineReached = false;

  while (!job.completed && matrixWrites < maxMatrixWrites) {
    if (
      hasDeadline
      && workUnits > 0
      && workUnits % deadlineCheckInterval === 0
      && now() >= options.deadlineMs
    ) {
      break;
    }
    const task = job.tasks[job.taskIndex];
    if (!task) {
      commitMatrixWriteJob(job);
      break;
    }
    const slotIndex = task.selectedSlotIndices[task.selectedIndex];
    if (slotIndex === undefined) {
      job.taskIndex++;
      continue;
    }
    const slot = task.slots[slotIndex];
    const enteringSlot = task.kind === 'branches' || task.cardIndex === 0;
    if (!slot || (enteringSlot && !job.isSlotVisible(slot))) {
      task.selectedIndex++;
      if (task.kind === 'cards') task.cardIndex = 0;
      workUnits++;
      continue;
    }

    if (task.kind === 'branches') {
      writeMatrix(
        task.instanceMatrices,
        task.writeIndex * 16,
        slot.matrix.elements,
      );
      const windOffset = task.writeIndex * 3;
      if (job.writeWindYOnly) task.windVectors[windOffset + 1] = 1;
      else writeVec3(task.windVectors, windOffset, 0, 1, 0);
      writeVec3(
        task.anchorPositions,
        task.writeIndex * 3,
        slot.pos.x,
        slot.pos.y,
        slot.pos.z,
      );
      task.writeIndex++;
      task.selectedIndex++;
      matrixWrites++;
      workUnits++;
      continue;
    }

    if (task.cardIndex === 0) {
        task.slotElements = slot.matrix.elements;
        task.slotMatrixAffine = isAffineMatrix(task.slotElements, 0);
        task.slotMatrixYUniform = isYUniformAffineMatrix(task.slotElements);
        task.treeX = slot.pos.x;
        task.treeY = slot.pos.y;
        task.treeZ = slot.pos.z;
        task.treeOriginY = job.resolveTreeOriginY(slot);
    }
    const slotElements = task.slotElements;
    const instanceMatrices = task.instanceMatrices;
    const sourceMatrices = task.sourceMatrices;
    const treeOrigins = task.treeOrigins;
    const windVectors = task.windVectors;
    const anchorPositions = task.anchorPositions;
    const weights = task.weights;
    const treeX = task.treeX;
    const treeY = task.treeY;
    const treeZ = task.treeZ;
    const treeOriginY = task.treeOriginY;
    const sourceMatricesAffine = task.sourceMatricesAffine;
    const slotMatrixAffine = task.slotMatrixAffine;
    const slotMatrixYUniform = task.slotMatrixYUniform;
    const writeWindYOnly = job.writeWindYOnly;
    while (
      task.cardIndex < task.cardsPerTree
      && matrixWrites < maxMatrixWrites
    ) {
      if (
        hasDeadline
        && workUnits > 0
        && workUnits % deadlineCheckInterval === 0
        && now() >= options.deadlineMs
      ) {
        deadlineReached = true;
        break;
      }
      const slotElements = task.slotElements;
      const outputOffset = task.writeIndex * 16;
      const sourceOffset = task.cardIndex * 16;
      if (sourceMatricesAffine && slotMatrixYUniform) {
        multiplyYUniformAffineMatricesInto(
          instanceMatrices,
          outputOffset,
          slotElements,
          sourceMatrices,
          sourceOffset,
        );
      } else if (sourceMatricesAffine && slotMatrixAffine) {
        multiplyAffineMatricesInto(
          instanceMatrices,
          outputOffset,
          slotElements,
          sourceMatrices,
          sourceOffset,
        );
      } else {
        multiplyMatricesInto(
          instanceMatrices,
          outputOffset,
          slotElements,
          sourceMatrices,
          sourceOffset,
        );
      }
      writeVec3(
        treeOrigins,
        task.writeIndex * 3,
        treeX,
        treeOriginY,
        treeZ,
      );
      const weight = weights ? weights[task.cardIndex] : 0.5;
      const windOffset = task.writeIndex * 3;
      if (writeWindYOnly) windVectors[windOffset + 1] = weight;
      else writeVec3(windVectors, windOffset, 0, weight, 0);
      writeVec3(
        anchorPositions,
        task.writeIndex * 3,
        treeX,
        treeY,
        treeZ,
      );
      task.writeIndex++;
      task.cardIndex++;
      matrixWrites++;
      workUnits++;
    }
    if (deadlineReached) break;
    if (task.cardIndex >= task.cardsPerTree) {
      task.cardIndex = 0;
      task.selectedIndex++;
    }
  }

  if (!job.completed && job.taskIndex >= job.tasks.length) {
    commitMatrixWriteJob(job);
  }
  return {
    completed: job.completed,
    matrixWrites,
    durationMs: now() - startedAt,
  };
}

/**
 * Run multiple fine matrix-write chunks without publishing partial results.
 *
 * This lets frame-budgeted consumers keep a small per-chunk preemption bound
 * while using any remaining deadline headroom to finish an atomic bucket.
 */
export function runInstanceMatrixWriteSlices(
  job,
  options,
) {
  const now = options.now ?? defaultNow;
  const startedAt = now();
  const deadlineMs = Number.isFinite(options.deadlineMs)
    ? options.deadlineMs
    : Number.POSITIVE_INFINITY;
  const minimumChunkHeadroomMs = Number.isFinite(options.minimumChunkHeadroomMs)
    ? Math.max(0, options.minimumChunkHeadroomMs)
    : 0;
  const maxChunks = Number.isFinite(options.maxChunks)
    ? Math.max(0, Math.floor(options.maxChunks))
    : Number.POSITIVE_INFINITY;
  let chunks = 0;
  let matrixWrites = 0;
  let maxMatrixWritesInChunk = 0;
  let stopReason = job.completed ? 'converged' : 'chunk-limit';

  while (!job.completed) {
    if (chunks >= maxChunks) {
      stopReason = 'chunk-limit';
      break;
    }
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      stopReason = 'time-limit';
      break;
    }
    if (remainingMs < minimumChunkHeadroomMs) {
      stopReason = 'headroom-limit';
      break;
    }

    const chunk = runInstanceMatrixWriteChunk(job, {
      deadlineMs,
      maxMatrixWrites: options.maxMatrixWritesPerChunk,
      deadlineCheckInterval: options.deadlineCheckInterval,
      now,
    });
    chunks++;
    matrixWrites += chunk.matrixWrites;
    maxMatrixWritesInChunk = Math.max(
      maxMatrixWritesInChunk,
      chunk.matrixWrites,
    );
    if (job.completed) {
      stopReason = 'converged';
      break;
    }
    if (chunk.matrixWrites === 0) {
      stopReason = now() >= deadlineMs ? 'time-limit' : 'no-progress';
      break;
    }
  }

  return {
    completed: job.completed,
    chunks,
    matrixWrites,
    maxMatrixWritesInChunk,
    durationMs: now() - startedAt,
    stopReason,
  };
}

function createMatrixWriteTasks(lodSet, slots, selectedSlotIndices) {
  const tasks = [];
  if (lodSet.branches) {
    tasks.push({
      kind: 'branches',
      mesh: lodSet.branches,
      slots,
      selectedSlotIndices,
      selectedIndex: 0,
      writeIndex: 0,
      instanceMatrices: requiredArray(lodSet.branches.instanceMatrix),
      windVec: requiredAttribute(lodSet.branches, 'aWindVec'),
      anchorPos: requiredAttribute(lodSet.branches, 'aAnchorPos'),
      windVectors: requiredArray(requiredAttribute(lodSet.branches, 'aWindVec')),
      anchorPositions: requiredArray(requiredAttribute(lodSet.branches, 'aAnchorPos')),
    });
  }
  for (const mesh of lodSet.cards) {
    tasks.push({
      kind: 'cards',
      mesh,
      slots,
      selectedSlotIndices,
      selectedIndex: 0,
      cardIndex: 0,
      writeIndex: 0,
      instanceMatrices: requiredArray(mesh.instanceMatrix),
      cardsPerTree: mesh.userData.k,
      sourceMatrices: mesh.userData.srcMatrices,
      sourceMatricesAffine: matricesAreAffine(
        mesh.userData.srcMatrices,
        mesh.userData.k,
      ),
      weights: mesh.userData.weights ?? null,
      treeOrigin: requiredAttribute(mesh, 'aTreeOrigin'),
      windVec: requiredAttribute(mesh, 'aWindVec'),
      anchorPos: requiredAttribute(mesh, 'aAnchorPos'),
      treeOrigins: requiredArray(requiredAttribute(mesh, 'aTreeOrigin')),
      windVectors: requiredArray(requiredAttribute(mesh, 'aWindVec')),
      anchorPositions: requiredArray(requiredAttribute(mesh, 'aAnchorPos')),
    });
  }
  return tasks;
}

function commitMatrixWriteJob(job) {
  for (const task of job.tasks) {
    task.mesh.count = task.writeIndex;
    task.mesh.instanceMatrix.needsUpdate = true;
    if (task.kind === 'branches') {
      task.windVec.needsUpdate = true;
      task.anchorPos.needsUpdate = true;
    } else {
      task.treeOrigin.needsUpdate = true;
      task.windVec.needsUpdate = true;
      task.anchorPos.needsUpdate = true;
    }
  }
  job.completed = true;
}

function requiredAttribute(mesh, name) {
  const attribute = mesh.geometry.attributes[name];
  if (!attribute) {
    throw new Error(`Instance matrix chunk job requires "${name}" on ${mesh.name || 'mesh'}.`);
  }
  return attribute;
}

function requiredArray(attribute) {
  const array = attribute?.array;
  if (!array || typeof array.length !== 'number') {
    throw new Error('Instance matrix chunk job requires writable buffer arrays.');
  }
  return array;
}

function writeVec3(target, offset, x, y, z) {
  target[offset] = x;
  target[offset + 1] = y;
  target[offset + 2] = z;
}

function writeMatrix(target, offset, source) {
  target[offset] = source[0];
  target[offset + 1] = source[1];
  target[offset + 2] = source[2];
  target[offset + 3] = source[3];
  target[offset + 4] = source[4];
  target[offset + 5] = source[5];
  target[offset + 6] = source[6];
  target[offset + 7] = source[7];
  target[offset + 8] = source[8];
  target[offset + 9] = source[9];
  target[offset + 10] = source[10];
  target[offset + 11] = source[11];
  target[offset + 12] = source[12];
  target[offset + 13] = source[13];
  target[offset + 14] = source[14];
  target[offset + 15] = source[15];
}

function matricesAreAffine(matrices, count) {
  if (!matrices || !Number.isFinite(count)) return false;
  for (let index = 0; index < count; index++) {
    if (!isAffineMatrix(matrices, index * 16)) return false;
  }
  return true;
}

function isAffineMatrix(elements, offset) {
  return elements[offset + 3] === 0
    && elements[offset + 7] === 0
    && elements[offset + 11] === 0
    && elements[offset + 15] === 1;
}

function isYUniformAffineMatrix(elements) {
  return elements[1] === 0
    && elements[3] === 0
    && elements[4] === 0
    && elements[6] === 0
    && elements[7] === 0
    && elements[9] === 0
    && elements[11] === 0
    && elements[15] === 1;
}

function multiplyYUniformAffineMatricesInto(
  target,
  targetOffset,
  left,
  right,
  rightOffset,
) {
  const horizontalX = left[0];
  const horizontalZ = left[8];
  const vertical = left[5];
  const horizontalX2 = left[2];
  const horizontalZ2 = left[10];
  const translateX = left[12];
  const translateY = left[13];
  const translateZ = left[14];

  const b11 = right[rightOffset];
  const b12 = right[rightOffset + 4];
  const b13 = right[rightOffset + 8];
  const b14 = right[rightOffset + 12];
  const b21 = right[rightOffset + 1];
  const b22 = right[rightOffset + 5];
  const b23 = right[rightOffset + 9];
  const b24 = right[rightOffset + 13];
  const b31 = right[rightOffset + 2];
  const b32 = right[rightOffset + 6];
  const b33 = right[rightOffset + 10];
  const b34 = right[rightOffset + 14];

  target[targetOffset] = horizontalX * b11 + horizontalZ * b31;
  target[targetOffset + 4] = horizontalX * b12 + horizontalZ * b32;
  target[targetOffset + 8] = horizontalX * b13 + horizontalZ * b33;
  target[targetOffset + 12] = horizontalX * b14 + horizontalZ * b34 + translateX;
  target[targetOffset + 1] = vertical * b21;
  target[targetOffset + 5] = vertical * b22;
  target[targetOffset + 9] = vertical * b23;
  target[targetOffset + 13] = vertical * b24 + translateY;
  target[targetOffset + 2] = horizontalX2 * b11 + horizontalZ2 * b31;
  target[targetOffset + 6] = horizontalX2 * b12 + horizontalZ2 * b32;
  target[targetOffset + 10] = horizontalX2 * b13 + horizontalZ2 * b33;
  target[targetOffset + 14] = horizontalX2 * b14 + horizontalZ2 * b34 + translateZ;
  target[targetOffset + 3] = 0;
  target[targetOffset + 7] = 0;
  target[targetOffset + 11] = 0;
  target[targetOffset + 15] = 1;
}

function multiplyAffineMatricesInto(target, targetOffset, left, right, rightOffset) {
  const a11 = left[0]; const a12 = left[4]; const a13 = left[8]; const a14 = left[12];
  const a21 = left[1]; const a22 = left[5]; const a23 = left[9]; const a24 = left[13];
  const a31 = left[2]; const a32 = left[6]; const a33 = left[10]; const a34 = left[14];

  const b11 = right[rightOffset];
  const b12 = right[rightOffset + 4];
  const b13 = right[rightOffset + 8];
  const b14 = right[rightOffset + 12];
  const b21 = right[rightOffset + 1];
  const b22 = right[rightOffset + 5];
  const b23 = right[rightOffset + 9];
  const b24 = right[rightOffset + 13];
  const b31 = right[rightOffset + 2];
  const b32 = right[rightOffset + 6];
  const b33 = right[rightOffset + 10];
  const b34 = right[rightOffset + 14];

  target[targetOffset] = a11 * b11 + a12 * b21 + a13 * b31;
  target[targetOffset + 4] = a11 * b12 + a12 * b22 + a13 * b32;
  target[targetOffset + 8] = a11 * b13 + a12 * b23 + a13 * b33;
  target[targetOffset + 12] = a11 * b14 + a12 * b24 + a13 * b34 + a14;
  target[targetOffset + 1] = a21 * b11 + a22 * b21 + a23 * b31;
  target[targetOffset + 5] = a21 * b12 + a22 * b22 + a23 * b32;
  target[targetOffset + 9] = a21 * b13 + a22 * b23 + a23 * b33;
  target[targetOffset + 13] = a21 * b14 + a22 * b24 + a23 * b34 + a24;
  target[targetOffset + 2] = a31 * b11 + a32 * b21 + a33 * b31;
  target[targetOffset + 6] = a31 * b12 + a32 * b22 + a33 * b32;
  target[targetOffset + 10] = a31 * b13 + a32 * b23 + a33 * b33;
  target[targetOffset + 14] = a31 * b14 + a32 * b24 + a33 * b34 + a34;
  target[targetOffset + 3] = 0;
  target[targetOffset + 7] = 0;
  target[targetOffset + 11] = 0;
  target[targetOffset + 15] = 1;
}

// Same column-major operation order as Matrix4.multiplyMatrices. Writing
// directly into the existing instance buffer removes per-instance Matrix4
// copies and BufferAttribute setter calls without changing Float32 results.
function multiplyMatricesInto(target, targetOffset, left, right, rightOffset) {
  const a11 = left[0]; const a12 = left[4]; const a13 = left[8]; const a14 = left[12];
  const a21 = left[1]; const a22 = left[5]; const a23 = left[9]; const a24 = left[13];
  const a31 = left[2]; const a32 = left[6]; const a33 = left[10]; const a34 = left[14];
  const a41 = left[3]; const a42 = left[7]; const a43 = left[11]; const a44 = left[15];

  const b11 = right[rightOffset];
  const b12 = right[rightOffset + 4];
  const b13 = right[rightOffset + 8];
  const b14 = right[rightOffset + 12];
  const b21 = right[rightOffset + 1];
  const b22 = right[rightOffset + 5];
  const b23 = right[rightOffset + 9];
  const b24 = right[rightOffset + 13];
  const b31 = right[rightOffset + 2];
  const b32 = right[rightOffset + 6];
  const b33 = right[rightOffset + 10];
  const b34 = right[rightOffset + 14];
  const b41 = right[rightOffset + 3];
  const b42 = right[rightOffset + 7];
  const b43 = right[rightOffset + 11];
  const b44 = right[rightOffset + 15];

  target[targetOffset] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
  target[targetOffset + 4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
  target[targetOffset + 8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
  target[targetOffset + 12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
  target[targetOffset + 1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
  target[targetOffset + 5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
  target[targetOffset + 9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
  target[targetOffset + 13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
  target[targetOffset + 2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
  target[targetOffset + 6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
  target[targetOffset + 10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
  target[targetOffset + 14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
  target[targetOffset + 3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
  target[targetOffset + 7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
  target[targetOffset + 11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
  target[targetOffset + 15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
}

function defaultSlotVisible(slot) {
  return slot.enabled !== false;
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

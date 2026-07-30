import { Matrix4 } from 'three/webgpu';

export const DEFAULT_INSTANCE_MATRIX_WRITES_PER_CHUNK = 256;
export const DEFAULT_INSTANCE_MATRIX_DEADLINE_CHECK_INTERVAL = 4;

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
    slotMatrix: new Matrix4(),
    cardMatrix: new Matrix4(),
    outputMatrix: new Matrix4(),
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
  let matrixWrites = 0;
  let workUnits = 0;

  while (!job.completed && matrixWrites < maxMatrixWrites) {
    if (
      workUnits > 0
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
    if (!slot || !job.isSlotVisible(slot)) {
      task.selectedIndex++;
      if (task.kind === 'cards') task.cardIndex = 0;
      workUnits++;
      continue;
    }

    if (task.kind === 'branches') {
      task.mesh.setMatrixAt(task.writeIndex, slot.matrix);
      task.windVec.setXYZ(task.writeIndex, 0, 1, 0);
      task.anchorPos.setXYZ(task.writeIndex, slot.pos.x, slot.pos.y, slot.pos.z);
      task.writeIndex++;
      task.selectedIndex++;
    } else {
      job.slotMatrix.copy(slot.matrix);
      job.cardMatrix.fromArray(task.sourceMatrices, task.cardIndex * 16);
      job.outputMatrix.multiplyMatrices(job.slotMatrix, job.cardMatrix);
      task.mesh.setMatrixAt(task.writeIndex, job.outputMatrix);
      task.treeOrigin.setXYZ(
        task.writeIndex,
        slot.pos.x,
        job.resolveTreeOriginY(slot),
        slot.pos.z,
      );
      const weight = task.weights?.[task.cardIndex] ?? 0.5;
      task.windVec.setXYZ(task.writeIndex, 0, weight, 0);
      task.anchorPos.setXYZ(task.writeIndex, slot.pos.x, slot.pos.y, slot.pos.z);
      task.writeIndex++;
      task.cardIndex++;
      if (task.cardIndex >= task.cardsPerTree) {
        task.cardIndex = 0;
        task.selectedIndex++;
      }
    }
    matrixWrites++;
    workUnits++;
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
      windVec: requiredAttribute(lodSet.branches, 'aWindVec'),
      anchorPos: requiredAttribute(lodSet.branches, 'aAnchorPos'),
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
      cardsPerTree: mesh.userData.k,
      sourceMatrices: mesh.userData.srcMatrices,
      weights: mesh.userData.weights ?? null,
      treeOrigin: requiredAttribute(mesh, 'aTreeOrigin'),
      windVec: requiredAttribute(mesh, 'aWindVec'),
      anchorPos: requiredAttribute(mesh, 'aAnchorPos'),
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

function defaultSlotVisible(slot) {
  return slot.enabled !== false;
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

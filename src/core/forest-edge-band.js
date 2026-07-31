// Deterministic, slot-neutral forest-edge reallocation.
//
// Consumers provide an ordered boundary polyline as samples with outward
// normals. The primitive moves existing source slots into clustered positions
// across a bounded band without creating render instances or coupling the plan
// to gameplay identity, species, terrain, or settlement geometry.

const DEFAULTS = Object.freeze({
  targetCount: 0,
  minBandDistance: 12,
  maxBandDistance: 20,
  maxClusterSize: 8,
  clusterTangentSpread: 3.2,
  clusterDepthSpread: 1.15,
  variantCount: 1,
  seed: 0,
  maxPlacementAttempts: 12,
});

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function integer(value, fallback, minimum = 0) {
  return Math.max(minimum, Math.floor(finite(value, fallback)));
}

function seedNumber(value) {
  if (Number.isFinite(value)) return Number(value) >>> 0;
  const text = String(value ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hash01(index, salt, seed) {
  let value = (
    Math.imul(index + 1, 0x9e3779b1)
    ^ Math.imul(salt + 1, 0x85ebca6b)
    ^ seed
  ) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

function normalizeEdgeSample(sample, index) {
  const x = finite(sample?.x, 0);
  const z = finite(sample?.z, 0);
  const outwardX = finite(sample?.outwardX, 0);
  const outwardZ = finite(sample?.outwardZ, 0);
  const length = Math.hypot(outwardX, outwardZ);
  if (length <= 1e-6) {
    throw new Error(`Forest edge sample ${index} requires a non-zero outward normal.`);
  }
  return {
    x,
    z,
    outwardX: outwardX / length,
    outwardZ: outwardZ / length,
  };
}

function normalizeSourceIndices(sourceItems, sourceIndices) {
  const indices = sourceIndices == null
    ? sourceItems.map((_, index) => index)
    : [...sourceIndices];
  const seen = new Set();
  for (const index of indices) {
    if (
      !Number.isInteger(index)
      || index < 0
      || index >= sourceItems.length
      || seen.has(index)
    ) {
      throw new Error(`Invalid or duplicate forest source index: ${index}.`);
    }
    seen.add(index);
  }
  return indices;
}

/**
 * Reallocate existing source slots into deterministic clusters in a boundary
 * band. The source array is not mutated and the returned `items` array always
 * has exactly the same length.
 *
 * `edgeSamples` should follow boundary order. Each sample is
 * `{ x, z, outwardX, outwardZ }`; band distance is measured along its normalized
 * outward vector. `sourceIndices` may restrict which existing slots are eligible
 * for reallocation.
 */
export function createForestEdgeBandReallocation(
  sourceItems,
  edgeSamples,
  options = {},
) {
  const targetCount = integer(
    options.targetCount,
    DEFAULTS.targetCount,
  );
  const minBandDistance = Math.max(
    0,
    finite(options.minBandDistance, DEFAULTS.minBandDistance),
  );
  const maxBandDistance = Math.max(
    minBandDistance,
    finite(options.maxBandDistance, DEFAULTS.maxBandDistance),
  );
  const maxClusterSize = integer(
    options.maxClusterSize,
    DEFAULTS.maxClusterSize,
    1,
  );
  const clusterTangentSpread = Math.max(
    0,
    finite(options.clusterTangentSpread, DEFAULTS.clusterTangentSpread),
  );
  const clusterDepthSpread = Math.max(
    0,
    finite(options.clusterDepthSpread, DEFAULTS.clusterDepthSpread),
  );
  const variantCount = integer(
    options.variantCount,
    DEFAULTS.variantCount,
    1,
  );
  const maxPlacementAttempts = integer(
    options.maxPlacementAttempts,
    DEFAULTS.maxPlacementAttempts,
    1,
  );
  const seed = seedNumber(options.seed ?? DEFAULTS.seed);
  const allowed = typeof options.isAllowedAt === 'function'
    ? options.isAllowedAt
    : () => true;
  const samples = edgeSamples.map(normalizeEdgeSample);
  const eligibleIndices = normalizeSourceIndices(
    sourceItems,
    options.sourceIndices,
  );

  if (targetCount > eligibleIndices.length) {
    throw new Error(
      `Forest edge reallocation requested ${targetCount} slots from `
      + `${eligibleIndices.length} eligible sources.`,
    );
  }
  if (targetCount > 0 && samples.length === 0) {
    throw new Error('Forest edge reallocation requires at least one edge sample.');
  }

  const rankedSourceIndices = eligibleIndices
    .map((sourceIndex) => ({
      sourceIndex,
      score: hash01(sourceIndex, 17, seed),
    }))
    .sort((left, right) => (
      left.score - right.score || left.sourceIndex - right.sourceIndex
    ))
    .slice(0, targetCount)
    .map(({ sourceIndex }) => sourceIndex);

  const clusterCount = targetCount === 0
    ? 0
    : Math.ceil(targetCount / maxClusterSize);
  const assignments = [];
  for (let assignmentIndex = 0; assignmentIndex < targetCount; assignmentIndex++) {
    const sourceIndex = rankedSourceIndices[assignmentIndex];
    const clusterIndex = Math.floor(assignmentIndex / maxClusterSize);
    const memberIndex = assignmentIndex % maxClusterSize;
    const clusterPhase = (
      clusterIndex + 0.16 + hash01(clusterIndex, 31, seed) * 0.68
    ) / clusterCount;
    const baseSampleIndex = Math.min(
      samples.length - 1,
      Math.floor(clusterPhase * samples.length),
    );
    const clusterDepth = minBandDistance
      + (maxBandDistance - minBandDistance)
        * (0.16 + hash01(clusterIndex, 41, seed) * 0.68);

    let placement = null;
    for (let attempt = 0; attempt < maxPlacementAttempts; attempt++) {
      const sampleOffset = attempt === 0
        ? 0
        : Math.ceil(attempt / 2) * (attempt % 2 === 0 ? -1 : 1);
      const sampleIndex = (
        baseSampleIndex + sampleOffset + samples.length
      ) % samples.length;
      const sample = samples[sampleIndex];
      const tangentX = -sample.outwardZ;
      const tangentZ = sample.outwardX;
      const tangentOffset = (
        hash01(assignmentIndex, 53 + attempt * 7, seed) * 2 - 1
      ) * clusterTangentSpread;
      const depthJitter = (
        hash01(memberIndex, 59 + clusterIndex * 11 + attempt, seed) * 2 - 1
      ) * clusterDepthSpread;
      const bandDistance = Math.max(
        minBandDistance,
        Math.min(maxBandDistance, clusterDepth + depthJitter),
      );
      const x = sample.x
        + sample.outwardX * bandDistance
        + tangentX * tangentOffset;
      const z = sample.z
        + sample.outwardZ * bandDistance
        + tangentZ * tangentOffset;
      if (!allowed(x, z, sourceIndex)) continue;
      placement = {
        sourceIndex,
        x,
        z,
        clusterIndex,
        memberIndex,
        edgeSampleIndex: sampleIndex,
        bandDistance,
        tangentOffset,
        variantIndex: (assignmentIndex + clusterIndex) % variantCount,
      };
      break;
    }
    if (!placement) {
      throw new Error(
        `Forest edge reallocation could not place source slot ${sourceIndex} `
        + `after ${maxPlacementAttempts} attempts.`,
      );
    }
    assignments.push(placement);
  }

  const assignmentBySourceIndex = new Map(
    assignments.map((assignment) => [assignment.sourceIndex, assignment]),
  );
  const items = sourceItems.map((item, sourceIndex) => {
    const assignment = assignmentBySourceIndex.get(sourceIndex);
    return assignment
      ? { ...item, x: assignment.x, z: assignment.z }
      : { ...item };
  });
  const observedBandDistances = assignments.map(
    (assignment) => assignment.bandDistance,
  );
  return {
    items,
    assignments,
    stats: {
      sourceCount: sourceItems.length,
      eligibleSourceCount: eligibleIndices.length,
      reallocatedCount: assignments.length,
      retainedCount: sourceItems.length - assignments.length,
      clusterCount,
      minBandDistance,
      maxBandDistance,
      observedMinBandDistance: observedBandDistances.length > 0
        ? Math.min(...observedBandDistances)
        : null,
      observedMaxBandDistance: observedBandDistances.length > 0
        ? Math.max(...observedBandDistances)
        : null,
    },
  };
}

export const FOREST_EDGE_BAND_DEFAULTS = DEFAULTS;

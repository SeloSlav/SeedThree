// Spatial visibility + two-rung forest LOD selection for large instanced forests.
//
// A single InstancedMesh has one aggregate bound, so an otherwise well-instanced
// forest still submits every tree whenever any part of the species bucket is in
// view. This selector keeps the batching win while returning compact, stable
// instance lists for:
//   near     — SeedThree's silhouette-complete mobile LOD2 hybrid
//   overview — SeedThree's crossed whole-limb LOD4 cards
//
// The selector is deliberately render-only. It never changes source placement
// arrays, collision state, or gameplay identity. Frustum padding keeps trees just
// outside the screen alive for shadows and camera motion; per-tree LOD hysteresis
// prevents boundary chatter.

import {
  Frustum,
  Matrix4,
  Sphere,
  Vector3,
} from 'three/webgpu';

const DEFAULTS = Object.freeze({
  cellSize: 48,
  frustumPadding: 24,
  nearDistance: 108,
  lodHysteresis: 14,
  minimumCameraMove: 2.25,
  minimumDirectionAngle: Math.PI / 180,
});

const COMPANION_DEFAULTS = Object.freeze({
  neighborRadius: 32,
  maxCompanions: 2,
  denseNeighborCount: 4,
  minOffset: 3.2,
  maxOffset: 7.2,
  minScale: 0.3,
  maxScale: 0.46,
});

const _projectionView = new Matrix4();
const _cameraPosition = new Vector3();
const _cameraDirection = new Vector3();
const _sphere = new Sphere();

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function sameIndices(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function projectionSignature(camera) {
  const e = camera.projectionMatrix.elements;
  // These six values cover perspective/orthographic zoom and aspect changes.
  return [e[0], e[5], e[8], e[9], e[10], e[14]];
}

function sameProjection(left, right) {
  if (!left || !right) return left === right;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (Math.abs(left[i] - right[i]) > 1e-7) return false;
  }
  return true;
}

function casterSignature(bounds) {
  if (!bounds) return null;
  return [bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ];
}

function selectionPolicySignature(options) {
  return [
    options.nearDistance,
    options.frustumPadding,
    options.casterPadding,
    options.lodHysteresis,
  ];
}

function intersectsCasterBounds(x, z, radius, bounds, padding) {
  if (!bounds) return false;
  const reach = radius + padding;
  return x + reach >= bounds.minX
    && x - reach <= bounds.maxX
    && z + reach >= bounds.minZ
    && z - reach <= bounds.maxZ;
}

function buildCells(items, cellSize) {
  const byKey = new Map();
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const cellX = Math.floor(item.x / cellSize);
    const cellZ = Math.floor(item.z / cellSize);
    const key = `${cellX}:${cellZ}`;
    let cell = byKey.get(key);
    if (!cell) {
      cell = {
        indices: [],
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity,
      };
      byKey.set(key, cell);
    }
    cell.indices.push(index);
    cell.minX = Math.min(cell.minX, item.x - item.radius);
    cell.minY = Math.min(cell.minY, item.y - item.radius);
    cell.minZ = Math.min(cell.minZ, item.z - item.radius);
    cell.maxX = Math.max(cell.maxX, item.x + item.radius);
    cell.maxY = Math.max(cell.maxY, item.y + item.radius);
    cell.maxZ = Math.max(cell.maxZ, item.z + item.radius);
  }

  const cells = [];
  for (const cell of byKey.values()) {
    const cx = (cell.minX + cell.maxX) * 0.5;
    const cy = (cell.minY + cell.maxY) * 0.5;
    const cz = (cell.minZ + cell.maxZ) * 0.5;
    const dx = cell.maxX - cx;
    const dy = cell.maxY - cy;
    const dz = cell.maxZ - cz;
    cells.push({
      indices: cell.indices,
      x: cx,
      y: cy,
      z: cz,
      radius: Math.hypot(dx, dy, dz),
    });
  }
  return cells;
}

function hash01(index, salt) {
  let value = (index + 1) * 0x9e3779b1 ^ (salt + 1) * 0x85ebca6b;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

/**
 * Derive deterministic, render-only understorey anchors between existing trees.
 *
 * The returned companion lists preserve the source array's index/identity and do
 * not mutate it. Each companion sits inside a corridor toward a nearby source
 * tree, so consumers can add forest mass without expanding a forest into roads,
 * clearings, or other open ground. A consumer should still apply its own terrain
 * and blocked-area checks before instancing.
 */
export function createForestCanopyCompanions(sourceItems, options = {}) {
  const neighborRadius = Math.max(
    2,
    finite(options.neighborRadius, COMPANION_DEFAULTS.neighborRadius),
  );
  const maxCompanions = Math.max(
    0,
    Math.min(4, Math.floor(finite(
      options.maxCompanions,
      COMPANION_DEFAULTS.maxCompanions,
    ))),
  );
  const denseNeighborCount = Math.max(
    2,
    Math.floor(finite(
      options.denseNeighborCount,
      COMPANION_DEFAULTS.denseNeighborCount,
    )),
  );
  const minOffset = Math.max(
    0.5,
    finite(options.minOffset, COMPANION_DEFAULTS.minOffset),
  );
  const maxOffset = Math.max(
    minOffset,
    finite(options.maxOffset, COMPANION_DEFAULTS.maxOffset),
  );
  const minScale = Math.max(
    0.05,
    finite(options.minScale, COMPANION_DEFAULTS.minScale),
  );
  const maxScale = Math.max(
    minScale,
    finite(options.maxScale, COMPANION_DEFAULTS.maxScale),
  );
  const items = sourceItems.map((item) => ({
    x: finite(item.x, 0),
    z: finite(item.z, 0),
  }));
  const companions = items.map(() => []);
  if (maxCompanions === 0 || items.length < 2) return companions;

  const cellSize = neighborRadius;
  const cells = new Map();
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const cellX = Math.floor(item.x / cellSize);
    const cellZ = Math.floor(item.z / cellSize);
    const key = `${cellX}:${cellZ}`;
    const cell = cells.get(key) ?? [];
    cell.push(index);
    cells.set(key, cell);
  }

  const radiusSq = neighborRadius * neighborRadius;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const cellX = Math.floor(item.x / cellSize);
    const cellZ = Math.floor(item.z / cellSize);
    const neighbors = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = cells.get(`${cellX + dx}:${cellZ + dz}`);
        if (!cell) continue;
        for (const neighborIndex of cell) {
          if (neighborIndex === index) continue;
          const neighbor = items[neighborIndex];
          const deltaX = neighbor.x - item.x;
          const deltaZ = neighbor.z - item.z;
          const distanceSq = deltaX * deltaX + deltaZ * deltaZ;
          if (distanceSq > radiusSq || distanceSq < 1) continue;
          neighbors.push({
            index: neighborIndex,
            deltaX,
            deltaZ,
            distanceSq,
          });
        }
      }
    }
    if (neighbors.length === 0) continue;
    neighbors.sort((left, right) => (
      left.distanceSq - right.distanceSq || left.index - right.index
    ));

    const targetCount = Math.min(
      maxCompanions,
      neighbors.length >= denseNeighborCount ? 2 : 1,
    );
    const selected = [neighbors[0]];
    if (targetCount > 1) {
      const first = neighbors[0];
      const firstLength = Math.sqrt(first.distanceSq);
      let best = null;
      let bestScore = -Infinity;
      for (let candidateIndex = 1; candidateIndex < neighbors.length; candidateIndex++) {
        const candidate = neighbors[candidateIndex];
        const candidateLength = Math.sqrt(candidate.distanceSq);
        const directionDot = (
          first.deltaX * candidate.deltaX + first.deltaZ * candidate.deltaZ
        ) / (firstLength * candidateLength);
        // Prefer a second corridor with a distinct silhouette direction, while
        // retaining a small nearest-neighbor bias.
        const score = (1 - directionDot) - candidateLength / neighborRadius * 0.12;
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      if (best) selected.push(best);
    }

    for (let companionIndex = 0; companionIndex < selected.length; companionIndex++) {
      const neighbor = selected[companionIndex];
      const distance = Math.sqrt(neighbor.distanceSq);
      const directionX = neighbor.deltaX / distance;
      const directionZ = neighbor.deltaZ / distance;
      const progress = 0.28 + hash01(index, companionIndex * 7 + 1) * 0.14;
      const corridorOffset = Math.min(
        maxOffset,
        distance * 0.46,
        Math.max(minOffset, distance * progress),
      );
      if (corridorOffset < 1.35) continue;
      const lateral = Math.min(1.15, distance * 0.075)
        * (hash01(index, companionIndex * 7 + 2) * 2 - 1);
      companions[index].push({
        offsetX: directionX * corridorOffset - directionZ * lateral,
        offsetZ: directionZ * corridorOffset + directionX * lateral,
        scale: minScale
          + (maxScale - minScale) * hash01(index, companionIndex * 7 + 3),
        rotation: Math.PI * 2 * hash01(index, companionIndex * 7 + 4),
      });
    }
  }
  return companions;
}

/**
 * Build a reusable selector.
 *
 * Each item is a conservative bounding sphere `{ x, y, z, radius }`. Indices in
 * returned selections always refer to this original array.
 */
export function createForestLodSelector(sourceItems, options = {}) {
  const cellSize = Math.max(8, finite(options.cellSize, DEFAULTS.cellSize));
  const items = sourceItems.map((item) => ({
    x: finite(item.x, 0),
    y: finite(item.y, 0),
    z: finite(item.z, 0),
    radius: Math.max(0.25, finite(item.radius, 1)),
  }));
  return {
    items,
    cells: buildCells(items, cellSize),
    cellSize,
    lodState: new Uint8Array(items.length), // 0 uninitialised, 1 near, 2 overview
    nearIndices: [],
    overviewIndices: [],
    viewIndices: [],
    lastCameraPosition: null,
    lastCameraDirection: null,
    lastProjection: null,
    lastCasterBounds: null,
    lastSelectionPolicy: null,
    hasSelection: false,
    revision: 0,
    options: { ...DEFAULTS, ...options, cellSize },
  };
}

/**
 * Return compact near/overview instance lists for the current camera.
 *
 * `force` bypasses the camera-motion guard. A skipped update returns the previous
 * immutable-by-convention lists with `changed:false, skipped:true`.
 */
export function selectForestLods(selector, camera, options = {}) {
  camera.updateMatrixWorld?.();
  camera.getWorldPosition(_cameraPosition);
  camera.getWorldDirection(_cameraDirection);
  const projection = projectionSignature(camera);
  const casterBounds = options.casterBounds ?? null;
  const casterBoundsSignature = casterSignature(casterBounds);

  const nearDistance = Math.max(
    1,
    finite(options.nearDistance, selector.options.nearDistance),
  );
  const minimumCameraMove = Math.max(
    0,
    finite(options.minimumCameraMove, selector.options.minimumCameraMove),
  );
  const minimumDirectionAngle = Math.max(
    0,
    finite(options.minimumDirectionAngle, selector.options.minimumDirectionAngle),
  );
  const padding = Math.max(
    0,
    finite(options.frustumPadding, selector.options.frustumPadding),
  );
  const casterPadding = Math.max(
    0,
    finite(options.casterPadding, padding),
  );
  const hysteresis = Math.max(
    0,
    Math.min(
      nearDistance * 0.45,
      finite(options.lodHysteresis, selector.options.lodHysteresis),
    ),
  );
  const selectionPolicy = selectionPolicySignature({
    nearDistance,
    frustumPadding: padding,
    casterPadding,
    lodHysteresis: hysteresis,
  });
  const directionDotThreshold = Math.cos(minimumDirectionAngle);
  const cameraMoved = !selector.lastCameraPosition
    || selector.lastCameraPosition.distanceToSquared(_cameraPosition)
      >= minimumCameraMove * minimumCameraMove;
  const cameraTurned = !selector.lastCameraDirection
    || selector.lastCameraDirection.dot(_cameraDirection) <= directionDotThreshold;
  const projectionChanged = !sameProjection(selector.lastProjection, projection);
  const casterBoundsChanged = !sameProjection(
    selector.lastCasterBounds,
    casterBoundsSignature,
  );
  const policyChanged = !sameProjection(selector.lastSelectionPolicy, selectionPolicy);

  if (
    selector.hasSelection
    && !options.force
    && !cameraMoved
    && !cameraTurned
    && !projectionChanged
    && !casterBoundsChanged
    && !policyChanged
  ) {
    return {
      nearIndices: selector.nearIndices,
      overviewIndices: selector.overviewIndices,
      viewIndices: selector.viewIndices,
      visibleCount: selector.nearIndices.length + selector.overviewIndices.length,
      culledCount: selector.items.length
        - selector.nearIndices.length
        - selector.overviewIndices.length,
      changed: false,
      skipped: true,
      revision: selector.revision,
    };
  }

  selector.lastCameraPosition = selector.lastCameraPosition ?? new Vector3();
  selector.lastCameraDirection = selector.lastCameraDirection ?? new Vector3();
  selector.lastCameraPosition.copy(_cameraPosition);
  selector.lastCameraDirection.copy(_cameraDirection);
  selector.lastProjection = projection;
  selector.lastCasterBounds = casterBoundsSignature;
  selector.lastSelectionPolicy = selectionPolicy;

  _projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const frustum = new Frustum().setFromProjectionMatrix(
    _projectionView,
    camera.coordinateSystem,
  );
  const nearEnter = nearDistance - hysteresis;
  const nearExit = nearDistance + hysteresis;
  const visible = [];
  const viewVisible = [];

  for (const cell of selector.cells) {
    _sphere.center.set(cell.x, cell.y, cell.z);
    _sphere.radius = cell.radius + padding;
    const cellInView = frustum.intersectsSphere(_sphere);
    const cellCastsIntoView = intersectsCasterBounds(
      cell.x,
      cell.z,
      cell.radius,
      casterBounds,
      casterPadding,
    );
    if (!cellInView && !cellCastsIntoView) continue;
    for (const index of cell.indices) {
      const item = selector.items[index];
      _sphere.center.set(item.x, item.y, item.z);
      _sphere.radius = item.radius + padding;
      const itemInView = frustum.intersectsSphere(_sphere);
      if (itemInView) viewVisible.push(index);
      if (
        itemInView
        || intersectsCasterBounds(
          item.x,
          item.z,
          item.radius,
          casterBounds,
          casterPadding,
        )
      ) {
        visible.push(index);
      }
    }
  }

  // Stable order means a static camera never churns instance buffers.
  visible.sort((a, b) => a - b);
  viewVisible.sort((a, b) => a - b);
  const near = [];
  const overview = [];
  for (const index of visible) {
    const item = selector.items[index];
    const distance = _cameraPosition.distanceTo(_sphere.center.set(item.x, item.y, item.z));
    const previous = selector.lodState[index];
    const useNear = previous === 1
      ? distance <= nearExit
      : previous === 2
        ? distance < nearEnter
        : distance <= nearDistance;
    selector.lodState[index] = useNear ? 1 : 2;
    (useNear ? near : overview).push(index);
  }

  const changed = !selector.hasSelection
    || !sameIndices(near, selector.nearIndices)
    || !sameIndices(overview, selector.overviewIndices)
    || !sameIndices(viewVisible, selector.viewIndices);
  selector.hasSelection = true;
  if (changed) {
    selector.nearIndices = near;
    selector.overviewIndices = overview;
    selector.viewIndices = viewVisible;
    selector.revision++;
  }

  return {
    nearIndices: selector.nearIndices,
    overviewIndices: selector.overviewIndices,
    viewIndices: selector.viewIndices,
    visibleCount: selector.nearIndices.length + selector.overviewIndices.length,
    culledCount: selector.items.length
      - selector.nearIndices.length
      - selector.overviewIndices.length,
    changed,
    skipped: false,
    revision: selector.revision,
  };
}

export const FOREST_LOD_DEFAULTS = DEFAULTS;
export const FOREST_COMPANION_DEFAULTS = COMPANION_DEFAULTS;

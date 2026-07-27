// Static, render-only forest-edge ecology for large SeedThree forests.
//
// The layer is deliberately independent from gameplay tree identity. It derives
// bounded clusters from dense source-tree anchors, never mutates source arrays,
// and uploads immutable instance matrices once at construction. Consumers keep
// ownership of blocked-area and terrain-height sampling.

import {
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  StaticDrawUsage,
  Vector3,
} from 'three/webgpu';

const DEFAULTS = Object.freeze({
  protectedRadius: 50,
  outerRadius: 175,
  neighborRadius: 34,
  minimumNeighbors: 2,
  minimumAnchorSpacing: 9,
  maxAnchors: 96,
  maxSaplings: 96,
  maxUnderstory: 192,
  maxDeadwood: 32,
  maxLitter: 192,
});

const Y_AXIS = new Vector3(0, 1, 0);

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
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

function spatialCells(items, cellSize) {
  const cells = new Map();
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const key = `${Math.floor(item.x / cellSize)}:${Math.floor(item.z / cellSize)}`;
    const cell = cells.get(key) ?? [];
    cell.push(index);
    cells.set(key, cell);
  }
  return cells;
}

function neighborCount(items, cells, index, radius) {
  const item = items[index];
  const cellX = Math.floor(item.x / radius);
  const cellZ = Math.floor(item.z / radius);
  const radiusSq = radius * radius;
  let count = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const otherIndex of cells.get(`${cellX + dx}:${cellZ + dz}`) ?? []) {
        if (otherIndex === index) continue;
        const other = items[otherIndex];
        const deltaX = other.x - item.x;
        const deltaZ = other.z - item.z;
        if (deltaX * deltaX + deltaZ * deltaZ <= radiusSq) count++;
      }
    }
  }
  return count;
}

function acceptAnchor(selected, candidate, minimumSpacing) {
  const minimumSq = minimumSpacing * minimumSpacing;
  for (const anchor of selected) {
    const deltaX = anchor.x - candidate.x;
    const deltaZ = anchor.z - candidate.z;
    if (deltaX * deltaX + deltaZ * deltaZ < minimumSq) return false;
  }
  return true;
}

/**
 * Derive deterministic ecology clusters from dense source-tree anchors.
 *
 * Returned entries contain only render data and retain `sourceIndex` so callers
 * can audit provenance without coupling them to harvest/collision state.
 */
export function createForestEdgeEcology(sourceItems, options = {}) {
  const protectedRadius = Math.max(
    0,
    finite(options.protectedRadius, DEFAULTS.protectedRadius),
  );
  const outerRadius = Math.max(
    protectedRadius + 8,
    finite(options.outerRadius, DEFAULTS.outerRadius),
  );
  const neighborRadius = Math.max(
    4,
    finite(options.neighborRadius, DEFAULTS.neighborRadius),
  );
  const minimumNeighbors = Math.max(
    1,
    Math.floor(finite(options.minimumNeighbors, DEFAULTS.minimumNeighbors)),
  );
  const minimumAnchorSpacing = Math.max(
    2,
    finite(options.minimumAnchorSpacing, DEFAULTS.minimumAnchorSpacing),
  );
  const maxAnchors = Math.max(
    0,
    Math.floor(finite(options.maxAnchors, DEFAULTS.maxAnchors)),
  );
  const limits = {
    saplings: Math.max(0, Math.floor(finite(options.maxSaplings, DEFAULTS.maxSaplings))),
    understory: Math.max(0, Math.floor(finite(options.maxUnderstory, DEFAULTS.maxUnderstory))),
    deadwood: Math.max(0, Math.floor(finite(options.maxDeadwood, DEFAULTS.maxDeadwood))),
    litter: Math.max(0, Math.floor(finite(options.maxLitter, DEFAULTS.maxLitter))),
  };
  const isBlockedAt = typeof options.isBlockedAt === 'function'
    ? options.isBlockedAt
    : () => false;
  const items = sourceItems.map((item) => ({
    x: finite(item.x, 0),
    z: finite(item.z, 0),
  }));
  const cells = spatialCells(items, neighborRadius);
  const candidates = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const radius = Math.hypot(item.x, item.z);
    if (radius < protectedRadius + 4 || radius > outerRadius) continue;
    const neighbors = neighborCount(items, cells, index, neighborRadius);
    if (neighbors < minimumNeighbors) continue;
    candidates.push({
      ...item,
      sourceIndex: index,
      radius,
      neighbors,
      score: hash01(index, 503) + Math.min(8, neighbors) * 0.045,
    });
  }
  candidates.sort((left, right) => (
    right.score - left.score
      || left.radius - right.radius
      || left.sourceIndex - right.sourceIndex
  ));

  const anchors = [];
  for (const candidate of candidates) {
    if (anchors.length >= maxAnchors) break;
    if (!acceptAnchor(anchors, candidate, minimumAnchorSpacing)) continue;
    anchors.push(candidate);
  }

  const ecology = {
    saplings: [],
    understory: [],
    deadwood: [],
    litter: [],
    anchorCount: anchors.length,
  };
  const allowed = (x, z) => (
    Math.hypot(x, z) >= protectedRadius
    && Math.hypot(x, z) <= outerRadius + 8
    && !isBlockedAt(x, z)
  );

  for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex++) {
    const anchor = anchors[anchorIndex];
    const radius = Math.max(1, anchor.radius);
    const inwardX = -anchor.x / radius;
    const inwardZ = -anchor.z / radius;
    const tangentX = -inwardZ;
    const tangentZ = inwardX;
    const inward = 1.8 + hash01(anchor.sourceIndex, 601) * 3.8;
    const lateral = (hash01(anchor.sourceIndex, 602) * 2 - 1) * 3.1;
    const centerX = anchor.x + inwardX * inward + tangentX * lateral;
    const centerZ = anchor.z + inwardZ * inward + tangentZ * lateral;
    const variant = Math.floor(hash01(anchor.sourceIndex, 603) * 3);

    if (
      ecology.saplings.length < limits.saplings
      && hash01(anchor.sourceIndex, 604) < 0.86
      && allowed(centerX, centerZ)
    ) {
      ecology.saplings.push({
        x: centerX,
        z: centerZ,
        scale: 0.72 + hash01(anchor.sourceIndex, 605) * 0.58,
        rotation: hash01(anchor.sourceIndex, 606) * Math.PI * 2,
        variant,
        sourceIndex: anchor.sourceIndex,
      });
    }

    const understoryCount = anchor.neighbors >= 5 ? 3 : 2;
    for (
      let member = 0;
      member < understoryCount && ecology.understory.length < limits.understory;
      member++
    ) {
      const angle = hash01(anchor.sourceIndex, 620 + member * 3) * Math.PI * 2;
      const spread = 1.4 + hash01(anchor.sourceIndex, 621 + member * 3) * 4.2;
      const x = centerX + Math.cos(angle) * spread;
      const z = centerZ + Math.sin(angle) * spread;
      if (!allowed(x, z)) continue;
      ecology.understory.push({
        x,
        z,
        scale: 0.64 + hash01(anchor.sourceIndex, 622 + member * 3) * 0.7,
        rotation: angle + hash01(anchor.sourceIndex, 623 + member * 3) * 0.6,
        variant,
        sourceIndex: anchor.sourceIndex,
      });
    }

    if (
      ecology.deadwood.length < limits.deadwood
      && anchorIndex % 3 === 1
    ) {
      const angle = hash01(anchor.sourceIndex, 641) * Math.PI * 2;
      const x = centerX + Math.cos(angle) * 2.2;
      const z = centerZ + Math.sin(angle) * 2.2;
      if (allowed(x, z)) {
        ecology.deadwood.push({
          x,
          z,
          length: 2.1 + hash01(anchor.sourceIndex, 642) * 2.2,
          rotation: angle + hash01(anchor.sourceIndex, 643) * 1.3,
          variant,
          sourceIndex: anchor.sourceIndex,
        });
      }
    }

    for (
      let member = 0;
      member < 2 && ecology.litter.length < limits.litter;
      member++
    ) {
      const angle = hash01(anchor.sourceIndex, 660 + member * 3) * Math.PI * 2;
      const spread = 0.8 + hash01(anchor.sourceIndex, 661 + member * 3) * 4.6;
      const x = centerX + Math.cos(angle) * spread;
      const z = centerZ + Math.sin(angle) * spread;
      if (!allowed(x, z)) continue;
      ecology.litter.push({
        x,
        z,
        scale: 0.9 + hash01(anchor.sourceIndex, 662 + member * 3) * 1.45,
        rotation: angle,
        variant: (variant + member) % 3,
        sourceIndex: anchor.sourceIndex,
      });
    }
  }
  return ecology;
}

function createMaterial(name, color, options = {}) {
  const parameters = {
    color,
    roughness: options.roughness ?? 0.98,
    metalness: 0,
  };
  if (options.side !== undefined) parameters.side = options.side;
  if (options.polygonOffset === true) {
    parameters.polygonOffset = true;
    parameters.polygonOffsetFactor = -1;
    parameters.polygonOffsetUnits = -1;
  }
  const material = new MeshStandardMaterial(parameters);
  material.name = name;
  return material;
}

function createStaticInstances(name, geometry, material, count) {
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(StaticDrawUsage);
  mesh.userData.neverCastShadow = true;
  mesh.userData.forestEcology = true;
  return mesh;
}

function finishInstances(mesh) {
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
}

function setColor(mesh, index, palette, variant) {
  mesh.setColorAt(index, new Color(palette[variant % palette.length]));
}

/**
 * Build five immutable instance batches from `createForestEdgeEcology` output.
 */
export function buildForestEdgeEcology(ecology, options = {}) {
  const getHeightAt = typeof options.getHeightAt === 'function'
    ? options.getHeightAt
    : () => 0;
  const group = new Group();
  group.name = options.name ?? 'SeedThree clearing-edge ecology';
  const materials = [];
  const meshes = [];
  const matrix = new Matrix4();
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();

  const trunkMaterial = createMaterial('SeedThree ecology young bark', 0x66503c);
  const saplingMaterial = createMaterial('SeedThree ecology sapling crowns', 0xffffff, {
    side: DoubleSide,
  });
  const understoryMaterial = createMaterial('SeedThree ecology understory crowns', 0xffffff);
  const deadwoodMaterial = createMaterial('SeedThree ecology deadwood', 0xffffff);
  const litterMaterial = createMaterial('SeedThree ecology leaf litter', 0xffffff, {
    side: DoubleSide,
    polygonOffset: true,
  });
  materials.push(
    trunkMaterial,
    saplingMaterial,
    understoryMaterial,
    deadwoodMaterial,
    litterMaterial,
  );

  if (ecology.saplings.length > 0) {
    const trunkGeometry = new CylinderGeometry(0.11, 0.17, 2.55, 6);
    trunkGeometry.translate(0, 1.275, 0);
    const crownGeometry = new ConeGeometry(0.92, 2.7, 7);
    crownGeometry.translate(0, 2.72, 0);
    const trunks = createStaticInstances(
      'SeedThree ecology sapling trunks',
      trunkGeometry,
      trunkMaterial,
      ecology.saplings.length,
    );
    const crowns = createStaticInstances(
      'SeedThree ecology clustered sapling crowns',
      crownGeometry,
      saplingMaterial,
      ecology.saplings.length,
    );
    const crownPalette = [0x496b39, 0x3e5f35, 0x567442];
    for (let index = 0; index < ecology.saplings.length; index++) {
      const item = ecology.saplings[index];
      position.set(item.x, getHeightAt(item.x, item.z), item.z);
      quaternion.setFromAxisAngle(Y_AXIS, item.rotation);
      scale.setScalar(item.scale);
      matrix.compose(position, quaternion, scale);
      trunks.setMatrixAt(index, matrix);
      crowns.setMatrixAt(index, matrix);
      setColor(crowns, index, crownPalette, item.variant);
    }
    finishInstances(trunks);
    finishInstances(crowns);
    group.add(trunks, crowns);
    meshes.push(trunks, crowns);
  }

  if (ecology.understory.length > 0) {
    const geometry = new SphereGeometry(1, 7, 5);
    const material = understoryMaterial;
    const mesh = createStaticInstances(
      'SeedThree ecology beech-fir understory clusters',
      geometry,
      material,
      ecology.understory.length,
    );
    const palette = [0x385a32, 0x42643a, 0x4b6a3b];
    for (let index = 0; index < ecology.understory.length; index++) {
      const item = ecology.understory[index];
      position.set(item.x, getHeightAt(item.x, item.z) + 0.72 * item.scale, item.z);
      quaternion.setFromAxisAngle(Y_AXIS, item.rotation);
      scale.set(1.22 * item.scale, 0.76 * item.scale, item.scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      setColor(mesh, index, palette, item.variant);
    }
    finishInstances(mesh);
    group.add(mesh);
    meshes.push(mesh);
  }

  if (ecology.deadwood.length > 0) {
    const geometry = new CylinderGeometry(0.16, 0.24, 1, 6);
    const mesh = createStaticInstances(
      'SeedThree ecology windfall deadwood',
      geometry,
      deadwoodMaterial,
      ecology.deadwood.length,
    );
    const palette = [0x5d4936, 0x6c5843, 0x4f4337];
    for (let index = 0; index < ecology.deadwood.length; index++) {
      const item = ecology.deadwood[index];
      position.set(item.x, getHeightAt(item.x, item.z) + 0.19, item.z);
      quaternion.setFromEuler(new Euler(0, item.rotation, Math.PI * 0.5));
      scale.set(1, item.length, 1);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      setColor(mesh, index, palette, item.variant);
    }
    finishInstances(mesh);
    group.add(mesh);
    meshes.push(mesh);
  }

  if (ecology.litter.length > 0) {
    const geometry = new CircleGeometry(1, 7);
    geometry.rotateX(-Math.PI * 0.5);
    const mesh = createStaticInstances(
      'SeedThree ecology leaf-litter islands',
      geometry,
      litterMaterial,
      ecology.litter.length,
    );
    const palette = [0x584730, 0x66513a, 0x493f31];
    for (let index = 0; index < ecology.litter.length; index++) {
      const item = ecology.litter[index];
      position.set(item.x, getHeightAt(item.x, item.z) + 0.035, item.z);
      quaternion.setFromAxisAngle(Y_AXIS, item.rotation);
      scale.set(item.scale * 1.35, 1, item.scale * 0.78);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      setColor(mesh, index, palette, item.variant);
    }
    finishInstances(mesh);
    group.add(mesh);
    meshes.push(mesh);
  }

  const counts = {
    anchors: ecology.anchorCount,
    saplings: ecology.saplings.length,
    understory: ecology.understory.length,
    deadwood: ecology.deadwood.length,
    litter: ecology.litter.length,
  };
  let triangles = 0;
  for (const mesh of meshes) {
    const geometryTriangles = mesh.geometry.index
      ? mesh.geometry.index.count / 3
      : mesh.geometry.attributes.position.count / 3;
    triangles += geometryTriangles * mesh.count;
  }
  const stats = {
    counts,
    draws: meshes.length,
    instances: meshes.reduce((sum, mesh) => sum + mesh.count, 0),
    triangles: Math.round(triangles),
  };
  return {
    group,
    stats,
    dispose() {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
      for (const material of materials) material.dispose();
    },
  };
}

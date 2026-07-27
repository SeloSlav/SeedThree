// Static, render-only forest-edge ecology for large SeedThree forests.
//
// The layer is deliberately independent from gameplay tree identity. It derives
// bounded clusters from dense source-tree anchors, never mutates source arrays,
// and uploads immutable instance matrices once at construction. Consumers keep
// ownership of blocked-area and terrain-height sampling.

import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
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
  const edgeBandWidth = Math.max(
    12,
    finite(options.edgeBandWidth, outerRadius - protectedRadius),
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
      score: hash01(index, 503) * 0.48
        + Math.min(8, neighbors) * 0.042
        + (
          1 - Math.min(
            1,
            Math.max(0, radius - protectedRadius - 4) / edgeBandWidth,
          )
        ) * 1.85,
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
  const sampleAllowed = (
    centerX,
    centerZ,
    sourceIndex,
    salt,
    minSpread,
    maxSpread,
    attempts = 4,
  ) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const angle = hash01(sourceIndex, salt + attempt * 11) * Math.PI * 2;
      const spread = minSpread
        + hash01(sourceIndex, salt + attempt * 11 + 1) * (maxSpread - minSpread);
      const x = centerX + Math.cos(angle) * spread;
      const z = centerZ + Math.sin(angle) * spread;
      if (allowed(x, z)) return { x, z, angle };
    }
    return null;
  };

  for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex++) {
    const anchor = anchors[anchorIndex];
    const radius = Math.max(1, anchor.radius);
    const outwardX = anchor.x / radius;
    const outwardZ = anchor.z / radius;
    const tangentX = -outwardZ;
    const tangentZ = outwardX;
    const edgeDepth = Math.pow(hash01(anchor.sourceIndex, 601), 1.65);
    const edgeRadius = protectedRadius + 5 + edgeDepth * edgeBandWidth;
    const lateral = (hash01(anchor.sourceIndex, 602) * 2 - 1) * 4.6;
    const centerX = outwardX * edgeRadius + tangentX * lateral;
    const centerZ = outwardZ * edgeRadius + tangentZ * lateral;
    const variant = Math.floor(hash01(anchor.sourceIndex, 603) * 3);

    if (
      ecology.saplings.length < limits.saplings
    ) {
      const placement = allowed(centerX, centerZ)
        ? { x: centerX, z: centerZ }
        : sampleAllowed(centerX, centerZ, anchor.sourceIndex, 604, 1.6, 5.4)
          ?? (allowed(anchor.x, anchor.z) ? { x: anchor.x, z: anchor.z } : null);
      if (placement) {
        ecology.saplings.push({
          x: placement.x,
          z: placement.z,
          scale: 0.94 + hash01(anchor.sourceIndex, 605) * 0.72,
          rotation: hash01(anchor.sourceIndex, 606) * Math.PI * 2,
          variant,
          sourceIndex: anchor.sourceIndex,
        });
      }
    }

    const understoryCount = 4;
    for (
      let member = 0;
      member < understoryCount && ecology.understory.length < limits.understory;
      member++
    ) {
      const placement = sampleAllowed(
        centerX,
        centerZ,
        anchor.sourceIndex,
        620 + member * 37,
        1.4,
        5.6,
      );
      if (!placement) continue;
      ecology.understory.push({
        x: placement.x,
        z: placement.z,
        scale: 0.86 + hash01(anchor.sourceIndex, 622 + member * 3) * 0.82,
        rotation: placement.angle + hash01(anchor.sourceIndex, 623 + member * 3) * 0.6,
        variant,
        sourceIndex: anchor.sourceIndex,
      });
    }

    if (
      ecology.deadwood.length < limits.deadwood
      && anchorIndex % 2 === 1
    ) {
      const placement = sampleAllowed(
        centerX,
        centerZ,
        anchor.sourceIndex,
        641,
        1.8,
        4.4,
      );
      if (placement) {
        ecology.deadwood.push({
          x: placement.x,
          z: placement.z,
          length: 2.1 + hash01(anchor.sourceIndex, 642) * 2.2,
          rotation: placement.angle + hash01(anchor.sourceIndex, 643) * 1.3,
          variant,
          sourceIndex: anchor.sourceIndex,
        });
      }
    }

    for (
      let member = 0;
      member < 3 && ecology.litter.length < limits.litter;
      member++
    ) {
      const placement = sampleAllowed(
        centerX,
        centerZ,
        anchor.sourceIndex,
        660 + member * 41,
        0.8,
        5.4,
      );
      if (!placement) continue;
      ecology.litter.push({
        x: placement.x,
        z: placement.z,
        scale: 0.9 + hash01(anchor.sourceIndex, 662 + member * 3) * 1.45,
        rotation: placement.angle,
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

function mergeStaticGeometries(parts) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let vertexOffset = 0;
  for (const part of parts) {
    const position = part.getAttribute('position');
    const normal = part.getAttribute('normal');
    const uv = part.getAttribute('uv');
    for (let index = 0; index < position.count; index++) {
      positions.push(position.getX(index), position.getY(index), position.getZ(index));
      normals.push(normal.getX(index), normal.getY(index), normal.getZ(index));
      uvs.push(uv.getX(index), uv.getY(index));
    }
    if (part.index) {
      for (let index = 0; index < part.index.count; index++) {
        indices.push(vertexOffset + part.index.getX(index));
      }
    } else {
      for (let index = 0; index < position.count; index++) {
        indices.push(vertexOffset + index);
      }
    }
    vertexOffset += position.count;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  for (const part of parts) part.dispose();
  return geometry;
}

function createIrregularUnderstoryGeometry() {
  const central = new ConeGeometry(0.78, 1.42, 5);
  central.translate(0, 0.71, 0);
  central.rotateY(0.18);
  const left = new ConeGeometry(0.58, 1.08, 5);
  left.translate(-0.52, 0.54, 0.12);
  left.rotateY(-0.34);
  const right = new ConeGeometry(0.54, 0.96, 5);
  right.translate(0.5, 0.48, -0.22);
  right.rotateY(0.52);
  const rear = new ConeGeometry(0.43, 0.82, 5);
  rear.translate(0.08, 0.41, 0.48);
  rear.rotateY(-0.62);
  return mergeStaticGeometries([central, left, right, rear]);
}

function createYoungFirCrownGeometry() {
  const lower = new ConeGeometry(1.02, 1.55, 7);
  lower.scale(1, 1, 0.9);
  lower.rotateY(0.18);
  lower.translate(-0.06, 2.05, 0.04);

  const middle = new ConeGeometry(0.8, 1.45, 7);
  middle.scale(0.94, 1, 1.04);
  middle.rotateY(-0.31);
  middle.translate(0.09, 2.82, -0.06);

  const leader = new ConeGeometry(0.56, 1.35, 6);
  leader.scale(1.02, 1, 0.9);
  leader.rotateY(0.47);
  leader.translate(-0.05, 3.5, 0.08);

  return mergeStaticGeometries([lower, middle, leader]);
}

function createMeadowEdgeClumpGeometry() {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let blade = 0; blade < 3; blade++) {
    const angle = blade / 3 * Math.PI;
    const sideX = Math.cos(angle) * 0.42;
    const sideZ = Math.sin(angle) * 0.42;
    const leanX = Math.sin(angle * 1.7 + 0.4) * 0.16;
    const leanZ = Math.cos(angle * 1.3 - 0.2) * 0.13;
    const offset = positions.length / 3;
    positions.push(
      -sideX, 0, -sideZ,
      sideX, 0, sideZ,
      sideX * 0.38 + leanX, 0.72 + blade * 0.08, sideZ * 0.38 + leanZ,
      -sideX * 0.38 + leanX, 0.72 + blade * 0.08, -sideZ * 0.38 + leanZ,
    );
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
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
    const crownGeometry = createYoungFirCrownGeometry();
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
    const crownPalette = [0x456846, 0x395a40, 0x526f4c];
    for (let index = 0; index < ecology.saplings.length; index++) {
      const item = ecology.saplings[index];
      position.set(item.x, getHeightAt(item.x, item.z), item.z);
      quaternion.setFromAxisAngle(Y_AXIS, item.rotation);
      scale.set(item.scale * 0.88, item.scale * 1.12, item.scale * 0.88);
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
    const geometry = createIrregularUnderstoryGeometry();
    const material = understoryMaterial;
    const mesh = createStaticInstances(
      'SeedThree ecology beech-fir understory clusters',
      geometry,
      material,
      ecology.understory.length,
    );
    const palette = [0x3c5b3b, 0x486641, 0x536f49];
    for (let index = 0; index < ecology.understory.length; index++) {
      const item = ecology.understory[index];
      position.set(item.x, getHeightAt(item.x, item.z) + 0.025, item.z);
      quaternion.setFromAxisAngle(Y_AXIS, item.rotation);
      scale.set(1.2 * item.scale, 1.04 * item.scale, 1.08 * item.scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      setColor(mesh, index, palette, item.variant);
    }
    finishInstances(mesh);
    group.add(mesh);
    meshes.push(mesh);
  }

  if (ecology.deadwood.length > 0) {
    const geometry = new CylinderGeometry(0.21, 0.3, 1, 6);
    const mesh = createStaticInstances(
      'SeedThree ecology windfall deadwood',
      geometry,
      deadwoodMaterial,
      ecology.deadwood.length,
    );
    const palette = [0x5d4936, 0x6c5843, 0x4f4337];
    for (let index = 0; index < ecology.deadwood.length; index++) {
      const item = ecology.deadwood[index];
      position.set(item.x, getHeightAt(item.x, item.z) + 0.24, item.z);
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
    const geometry = createMeadowEdgeClumpGeometry();
    const mesh = createStaticInstances(
      'SeedThree ecology meadow-edge herb clumps',
      geometry,
      litterMaterial,
      ecology.litter.length,
    );
    const palette = [0x697047, 0x73784b, 0x59663f];
    for (let index = 0; index < ecology.litter.length; index++) {
      const item = ecology.litter[index];
      position.set(item.x, getHeightAt(item.x, item.z) + 0.02, item.z);
      quaternion.setFromAxisAngle(Y_AXIS, item.rotation);
      scale.set(item.scale * 1.2, item.scale * 0.86, item.scale);
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

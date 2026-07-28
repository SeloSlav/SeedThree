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
  DodecahedronGeometry,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  Quaternion,
  StaticDrawUsage,
  Vector3,
} from 'three/webgpu';
import {
  attribute,
  float,
  mix,
  uniform,
  vec3,
} from 'three/tsl';

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

function createSeasonalUnderstoryMaterial() {
  const material = new MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.98,
    metalness: 0,
    alphaTest: 0.5,
  });
  material.name = 'SeedThree ecology seasonal understory';
  const dormancy = uniform(0);
  const seasonalLeaf = attribute('aSeasonalLeaf', 'float');
  const deciduousInstance = attribute('aDeciduous', 'float');
  const retain = float(1).sub(seasonalLeaf.mul(deciduousInstance).mul(dormancy));
  // NodeMaterial automatically multiplies colorNode by its special
  // `instanceColor` varying. Reading it as a generic geometry attribute resolves
  // to zero because it lives on InstancedMesh, not geometry. Keep
  // foliage white here so the authored palette is applied exactly once.
  material.colorNode = mix(vec3(0.92, 0.78, 0.6), vec3(1), seasonalLeaf);
  material.opacityNode = retain;
  material.userData.forestSeasonalDormancy = dormancy;
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
  const seasonalLeaves = [];
  const indices = [];
  let vertexOffset = 0;
  for (const part of parts) {
    const position = part.getAttribute('position');
    const normal = part.getAttribute('normal');
    const uv = part.getAttribute('uv');
    const seasonalLeaf = part.userData.seasonalLeaf === true ? 1 : 0;
    for (let index = 0; index < position.count; index++) {
      positions.push(position.getX(index), position.getY(index), position.getZ(index));
      normals.push(normal.getX(index), normal.getY(index), normal.getZ(index));
      uvs.push(uv.getX(index), uv.getY(index));
      seasonalLeaves.push(seasonalLeaf);
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
  geometry.setAttribute('aSeasonalLeaf', new Float32BufferAttribute(seasonalLeaves, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  for (const part of parts) part.dispose();
  return geometry;
}

function createIrregularUnderstoryGeometry() {
  const parts = [];
  const twigTips = [
    new Vector3(-0.5, 1.04, 0.08),
    new Vector3(0.5, 0.92, -0.2),
    new Vector3(0.12, 1.2, 0.37),
    new Vector3(-0.18, 0.82, -0.42),
    new Vector3(0.02, 1.42, -0.04),
  ];
  const twigBase = new Vector3(0, 0.04, 0);
  const delta = new Vector3();
  const midpoint = new Vector3();
  const orientation = new Quaternion();
  for (const tip of twigTips) {
    delta.copy(tip).sub(twigBase);
    const length = delta.length();
    orientation.setFromUnitVectors(Y_AXIS, delta.normalize());
    const twig = new CylinderGeometry(0.025, 0.055, length, 5);
    twig.applyQuaternion(orientation);
    midpoint.copy(twigBase).add(tip).multiplyScalar(0.5);
    twig.translate(midpoint.x, midpoint.y, midpoint.z);
    twig.userData.seasonalLeaf = false;
    parts.push(twig);
  }

  // Rounded, offset dodecahedral lobes read as a broken shrub mass from every
  // camera angle. They replace the old four five-sided cones that appeared as
  // solid triangular miniature trees along the upper overview edge.
  const lobes = [
    { x: -0.42, y: 0.92, z: 0.06, sx: 0.66, sy: 0.64, sz: 0.57, ry: 0.18 },
    { x: 0.43, y: 0.78, z: -0.18, sx: 0.61, sy: 0.55, sz: 0.63, ry: -0.34 },
    { x: 0.06, y: 1.12, z: 0.29, sx: 0.58, sy: 0.63, sz: 0.54, ry: 0.51 },
    { x: -0.13, y: 0.72, z: -0.37, sx: 0.53, sy: 0.48, sz: 0.58, ry: -0.61 },
    { x: 0.02, y: 1.38, z: -0.04, sx: 0.48, sy: 0.56, sz: 0.46, ry: 0.29 },
    { x: -0.62, y: 0.61, z: -0.2, sx: 0.43, sy: 0.39, sz: 0.47, ry: 0.78 },
  ];
  for (const lobe of lobes) {
    const foliage = new DodecahedronGeometry(1, 0);
    foliage.scale(lobe.sx, lobe.sy, lobe.sz);
    foliage.rotateY(lobe.ry);
    foliage.translate(lobe.x, lobe.y, lobe.z);
    foliage.userData.seasonalLeaf = true;
    parts.push(foliage);
  }
  return mergeStaticGeometries(parts);
}

function createYoungFirCrownGeometry() {
  const parts = [];

  // Overlapping, offset whorls keep the young fir's conical read without one
  // low-sided paper silhouette. Two vertical segments soften each tier's facet
  // transition while distinct rotations prevent their edges from lining up.
  const lower = new ConeGeometry(1.08, 1.02, 12, 2);
  lower.scale(1, 1, 0.88);
  lower.rotateY(0.16);
  lower.translate(-0.08, 1.86, 0.05);
  parts.push(lower);

  const lowerMiddle = new ConeGeometry(0.93, 1.04, 11, 2);
  lowerMiddle.scale(0.92, 1, 1.04);
  lowerMiddle.rotateY(-0.27);
  lowerMiddle.translate(0.09, 2.36, -0.08);
  parts.push(lowerMiddle);

  const upper = new ConeGeometry(0.73, 1, 11, 2);
  upper.scale(1.05, 1, 0.9);
  upper.rotateY(0.43);
  upper.translate(-0.04, 2.87, 0.07);
  parts.push(upper);

  const leader = new ConeGeometry(0.5, 1.16, 10, 2);
  leader.scale(0.9, 1, 1.06);
  leader.rotateY(-0.12);
  leader.translate(0.04, 3.44, -0.03);
  parts.push(leader);

  // Broken lateral sprays protrude beyond the tier envelope at alternating
  // whorls. Each is a small closed seven-sided cluster rooted at the leader;
  // they add side-on branch rhythm and irregular negative spaces while all
  // remaining part of the same merged, single-draw crown geometry.
  const sprayWhorls = [
    { y: 1.58, count: 4, length: 1.02, radius: 0.2, offset: 0.18, droop: -0.16 },
    { y: 2.18, count: 3, length: 0.84, radius: 0.17, offset: 0.72, droop: -0.1 },
    { y: 2.72, count: 3, length: 0.66, radius: 0.14, offset: 0.34, droop: -0.04 },
  ];
  const direction = new Vector3();
  const orientation = new Quaternion();
  for (const whorl of sprayWhorls) {
    for (let index = 0; index < whorl.count; index++) {
      const angle = whorl.offset + index / whorl.count * Math.PI * 2;
      direction.set(Math.cos(angle), whorl.droop, Math.sin(angle)).normalize();
      orientation.setFromUnitVectors(Y_AXIS, direction);
      const spray = new ConeGeometry(whorl.radius, whorl.length, 7);
      spray.scale(1, 1, 0.76);
      spray.applyQuaternion(orientation);
      spray.translate(
        direction.x * whorl.length * 0.5,
        whorl.y + direction.y * whorl.length * 0.5,
        direction.z * whorl.length * 0.5,
      );
      parts.push(spray);
    }
  }

  return mergeStaticGeometries(parts);
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
  const understoryMaterial = createSeasonalUnderstoryMaterial();
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
    const crownPalette = [0x2f5339, 0x274833, 0x385b3c];
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
    const deciduous = new InstancedBufferAttribute(
      new Float32Array(ecology.understory.length),
      1,
    );
    deciduous.setUsage(StaticDrawUsage);
    geometry.setAttribute('aDeciduous', deciduous);
    const palette = [0x304d34, 0x3b5738, 0x455f3f];
    for (let index = 0; index < ecology.understory.length; index++) {
      const item = ecology.understory[index];
      position.set(item.x, getHeightAt(item.x, item.z) + 0.025, item.z);
      quaternion.setFromAxisAngle(Y_AXIS, item.rotation);
      scale.set(1.2 * item.scale, 1.04 * item.scale, 1.08 * item.scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      setColor(mesh, index, palette, item.variant);
      // Variant 0 is the evergreen fir constituent; the two broadleaf variants
      // drop only their foliage lobes while retaining the merged woody twigs.
      deciduous.setX(index, item.variant % 3 === 0 ? 0 : 1);
    }
    deciduous.needsUpdate = true;
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
    setDeciduousDormancy(amount) {
      const dormancy = understoryMaterial.userData.forestSeasonalDormancy;
      const next = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0));
      if (!dormancy || dormancy.value === next) return false;
      dormancy.value = next;
      return true;
    },
    dispose() {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
      for (const material of materials) material.dispose();
    },
  };
}

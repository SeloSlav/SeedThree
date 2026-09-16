// Black chokeberry (Aronia melanocarpa) — dense, suckering multi-stem shrub.
// Real clustered fruit is supplied by aronia_cluster.glb in the game adapter.
export const aronia = {
  name: 'Black Chokeberry', latin: 'Aronia melanocarpa', category: 'shrub',
  bark: 'aronia_branch_albedo.png', leaf: 'aronia_spray_albedo.png', biome: 'temperate',
  tileWorldSize: 0.32, plantSink: 0.014, foliageType: 'sprayClusters',
  foliage: {
    clustersPerBranch: 4, clusterSize: 0.22, clusterSizeVar: 0.18, clusterQuads: 2,
    alphaTest: 0.42, tint: 0xe0efc0, transmit: [0.24, 0.42, 0.16],
    downAngle: 35, downAngleV: 12, droop: 10, startFrac: 0.14,
    parentSprays: 0.82, rotate: 137,
  },
  params: {
    trunks: 7, trunkSplayDeg: 24, firstForkHeight: 0.1, armLength: 0.3,
    armFalloff: 0.87, forkGenerations: 4, branchiness: 0.76, forkSpread: 24,
    forkTriChance: 0.1, curlUp: 0.28, armBend: 10, gnarliness: 7,
    continuationKink: 5, forkRadiusKeep: 0.74, trunkRadius: 0.012,
    trunkFlare: 1.14, branchRepel: 0.7, minRadius: 0.0022,
    radialSegs: 6, segCurveRes: 4, tileWorldSize: 0.32, barkGrainU: true,
    windWeightScale: 0.24,
  },
};

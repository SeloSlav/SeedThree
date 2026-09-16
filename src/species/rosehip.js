// Dog rose (Rosa canina) — arching thorny canes with an open fountain habit.
// Real hips are supplied by rosehip_cluster.glb in the game adapter.
export const rosehip = {
  name: 'Dog Rose Rosehip', latin: 'Rosa canina', category: 'shrub',
  bark: 'rosehip_cane_albedo.png', leaf: 'rosehip_spray_albedo.png', biome: 'temperate',
  tileWorldSize: 0.28, plantSink: 0.012, foliageType: 'sprayClusters',
  foliage: {
    clustersPerBranch: 4, clusterSize: 0.25, clusterSizeVar: 0.22, clusterQuads: 2,
    alphaTest: 0.4, tint: 0xd4e8b2, transmit: [0.3, 0.46, 0.18],
    downAngle: 42, downAngleV: 18, droop: 22, startFrac: 0.12,
    parentSprays: 0.7, rotate: 137,
  },
  params: {
    trunks: 6, trunkSplayDeg: 38, firstForkHeight: 0.07, armLength: 0.34,
    armFalloff: 0.9, forkGenerations: 4, branchiness: 0.62, forkSpread: 20,
    forkTriChance: 0.03, curlUp: 0.12, armBend: 21, gnarliness: 11,
    continuationKink: 9, forkRadiusKeep: 0.7, trunkRadius: 0.009,
    trunkFlare: 1.1, branchRepel: 0.58, minRadius: 0.0018,
    radialSegs: 6, segCurveRes: 4, tileWorldSize: 0.28, barkGrainU: true,
    windWeightScale: 0.3,
  },
};

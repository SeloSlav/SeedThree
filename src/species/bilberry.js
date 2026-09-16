// Bilberry (Vaccinium myrtillus) — Gorski Kotar integration preset authored on
// SkyeShark's exact dichotomous shrub generator and spray-card grammar. Real
// fruit is supplied by bilberry_berry.glb in the game adapter.
export const bilberry = {
  name: 'Gorski Bilberry', latin: 'Vaccinium myrtillus', category: 'shrub',
  bark: 'bilberry_branch_albedo.png', leaf: 'bilberry_albedo.png', biome: 'temperate',
  tileWorldSize: 0.35, plantSink: 0.012, foliageType: 'sprayClusters',
  foliage: {
    clustersPerBranch: 4, clusterSize: 0.17, clusterSizeVar: 0.28, clusterQuads: 2,
    alphaTest: 0.44, tint: 0xd8efbb, transmit: [0.28, 0.46, 0.18],
    downAngle: 34, downAngleV: 14, droop: 12, startFrac: 0.18,
    parentSprays: 0.5, rotate: 137,
  },
  params: {
    trunks: 5, trunkSplayDeg: 38, firstForkHeight: 0.04, armLength: 0.15,
    armFalloff: 0.84, forkGenerations: 4, branchiness: 0.78, forkSpread: 29,
    forkTriChance: 0.08, curlUp: 0.16, armBend: 11, gnarliness: 13,
    continuationKink: 10, forkRadiusKeep: 0.76, trunkRadius: 0.008,
    trunkFlare: 1.15, branchRepel: 0.5, minRadius: 0.0018,
    radialSegs: 5, segCurveRes: 3, tileWorldSize: 0.35, barkGrainU: true,
    windWeightScale: 0.22,
  },
};

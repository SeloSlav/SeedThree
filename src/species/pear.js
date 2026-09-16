// European pear (Pyrus communis) — cultivated standard orchard form. A clear
// central leader and steep scaffold angles preserve pear's narrow oval crown,
// deliberately contrasting apple's low dome and cherry's rounded canopy.
import { broadleafControls } from './broadleaf-controls.js';

export const pear = {
  name: 'European Pear', latin: 'Pyrus communis', category: 'tree',
  bark: 'pear_bark_albedo.png', leaf: 'pear_single_albedo.png', biome: 'temperate',
  tileWorldSize: 1.15, controls: broadleafControls, terminalStemsAreGuides: true,
  fruit: { mesh: 'pear.glb', perBranch: 1, chance: 0.52, startFrac: 0.34, maxCount: 120 },
  foliage: {
    mode: 'leaves', clustersPerBranch: 3, clusterSize: 0.62, clusterSizeVar: 0.16,
    clusterQuads: 2, tint: 0xc5d99a, leavesPerBranch: 8, size: 0.23, sizeVar: 0.16,
    startFrac: 0.12, downAngle: 43, bend: 0, trunkClearRadius: 0.48,
    cardCoverage: 1.42, cardRadialPlanes: 2, cardCrownUnderlay: true,
    cardCrownUnderlayLateralScale: 1.12, mobileNearTwigCollapse: true,
  },
  params: {
    scale: 5.8, scaleV: 0.42, levels: 4, ratio: 0.031, ratioPower: 1.34,
    baseSize: 0.34, shape: 0, flare: 0.34, attractionUp: 0.62,
    attractionUpMinLevel: 1, baseSplits: 0, baseSplitAngle: 0,
    decurrentTrunk: false, decurrentTrunkExtension: 0,
    length: [1, 0.48, 0.28, 0.13], lengthV: [0, 0.08, 0.07, 0.035],
    lengthAbsolute: [null, null, null, 0.43], lengthAbsoluteV: [0, 0, 0, 0.08],
    lengthMin: [0, 0, 0, 0.28], lengthMax: [null, null, null, 0.58],
    taper: [1, 1, 1, 1], curveRes: [10, 8, 6, 4],
    curve: [3, 9, 7, 2], curveBack: [0, 4, 3, 0], curveV: [7, 13, 17, 12],
    downAngle: [0, 38, 43, 50], downAngleV: [0, 8, 9, 11],
    downAngleProgress: [0, -10, -4, 0], rotate: [0, 137, 160, 172],
    rotateV: [0, 22, 20, 15], branches: [0, 10, 15, 13],
    branchTiers: [0, 4, 0, 0], branchTierSpread: [0, 0.2, 1, 1],
    radialSegments: [10, 7, 5, 4], branchStart: [0, 0.22, 0.12, 0.06],
    branchEnd: [1, 0.96, 0.98, 0.98], branchDistPower: [1, 1.04, 0.94, 1],
    branchJitter: [0, 0.016, 0.015, 0.012],
  },
};

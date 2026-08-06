import assert from 'node:assert/strict';
import { generateSkeleton } from '../src/core/weber-penn.js';
import { Rng } from '../src/core/rng.js';
import { apple } from '../src/species/apple.js';
import { cherry } from '../src/species/cherry.js';

function metrics(species, seed) {
  const { stems, tips } = generateSkeleton(species.params, new Rng(`${species.name}:${seed}`));
  const roots = stems.filter((stem) => stem.level === 0);
  const scaffolds = stems.filter((stem) => stem.level === 1);
  const points = stems.flatMap((stem) => stem.points);
  const height = Math.max(...points.map((point) => point.y));
  const radius = Math.max(...points.map((point) => Math.hypot(point.x, point.z)));
  const scaffoldAngles = scaffolds.map((stem) => {
    const direction = stem.points[1].clone().sub(stem.points[0]).normalize();
    return Math.acos(Math.max(-1, Math.min(1, direction.y))) * 180 / Math.PI;
  });
  return {
    roots: roots.length,
    tips: tips.length,
    crownRatio: radius / height,
    height,
    meanScaffoldAngle: scaffoldAngles.reduce((sum, angle) => sum + angle, 0) / scaffoldAngles.length,
    attachmentHeights: scaffolds.map((stem) => stem.points[0].y).sort((a, b) => a - b),
  };
}

assert.equal(apple.params.baseSplits, 0, 'apple must keep one load-bearing central leader');
assert.equal(cherry.params.baseSplits, 0, 'sweet cherry must keep its strong central leader');
assert.equal(apple.params.levels, 4, 'apple needs a distinct fruiting-spur level');
assert.equal(cherry.params.levels, 4, 'cherry needs short fruiting wood beyond its laterals');
assert.equal(apple.params.branchTiers[1], 3, 'apple scaffolds should form separated sets');
assert.equal(cherry.params.branchTiers[1], 4, 'cherry should show rhythmic annual branch tiers');

for (let seed = 0; seed < 12; seed++) {
  const a = metrics(apple, seed);
  const c = metrics(cherry, seed);

  assert.equal(a.roots, 1);
  assert.equal(c.roots, 1);
  assert.ok(a.tips >= c.tips * 1.5, 'apple should carry denser short fruiting wood');
  assert.ok(a.crownRatio > 0.5, 'apple should keep a broad, spreading crown');
  assert.ok(c.crownRatio > 0.3 && c.crownRatio < 0.53,
    'sweet cherry should retain an upright but healthy egg-shaped crown');
  assert.ok(a.meanScaffoldAngle >= 55 && a.meanScaffoldAngle <= 68,
    'apple scaffold angles should stay in the broad, fruit-bearing range');
  assert.ok(c.meanScaffoldAngle >= 40 && c.meanScaffoldAngle <= 52,
    'sweet cherry primary branches should remain naturally ascending');
  assert.ok(c.height > a.height * 1.06, 'sweet cherry should read taller than apple');

  // Four cherry tiers contain an equal shoot set. Annual gaps must be much larger
  // than the small height spread within one tier.
  const withinTierSpans = [];
  const betweenTierGaps = [];
  const shootsPerTier = cherry.params.branches[1] / cherry.params.branchTiers[1];
  for (let tier = 0; tier < 4; tier++) {
    const start = tier * shootsPerTier;
    withinTierSpans.push(
      c.attachmentHeights[start + shootsPerTier - 1] - c.attachmentHeights[start],
    );
    if (tier < 3) betweenTierGaps.push(
      c.attachmentHeights[start + shootsPerTier] - c.attachmentHeights[start + shootsPerTier - 1],
    );
  }
  assert.ok(Math.min(...betweenTierGaps) > Math.max(...withinTierSpans) * 4,
    'sweet cherry must retain visible gaps between annual branch tiers');
}

console.log('SeedThree apple/cherry morphology tests passed.');

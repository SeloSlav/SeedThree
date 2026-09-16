import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bilberry } from '../src/species/bilberry.js';
import { commonHornbeamHedge } from '../src/species/common-hornbeam-hedge.js';
import { commonJuniper } from '../src/species/common-juniper.js';
import { SPECIES } from '../src/species/index.js';
import { raspberry } from '../src/species/raspberry.js';
import { stingingNettle } from '../src/species/stinging-nettle.js';

const assetRoot = fileURLToPath(new URL('../assets/', import.meta.url));
const contracts = [
  { key: 'bilberry', name: 'bilberry', preset: bilberry, foliageBase: 'bilberry' },
  { key: 'commonJuniper', name: 'common juniper', preset: commonJuniper, foliageBase: 'juniper_scrub' },
  { key: 'raspberry', name: 'raspberry', preset: raspberry, foliageBase: 'raspberry_spray' },
  {
    key: 'commonHornbeamHedge',
    name: 'field hornbeam',
    preset: commonHornbeamHedge,
    foliageBase: 'hornbeam_hedge_spray',
  },
  {
    key: 'stingingNettle',
    name: 'stinging nettle',
    preset: stingingNettle,
    foliageBase: 'stinging_nettle_single',
  },
];
const albedoOwners = new Map();

for (const contract of contracts) {
  assert.equal(SPECIES[contract.key], contract.preset, `${contract.name} must be registered as a first-class species`);
  const barkBase = contract.preset.bark.replace(/_albedo\.png$/, '');
  assertTextureSet(contract.name, 'bark', barkBase, ['albedo', 'normal', 'roughness']);
  assertTextureSet(
    contract.name,
    'leaves',
    contract.foliageBase,
    ['albedo', 'normal', 'roughness', 'translucency'],
  );
}

assert.equal(stingingNettle.category, 'shrub');
assert.equal(stingingNettle.foliageType, 'singleLeaves');
assert.equal(stingingNettle.foliage.mode, 'leaves');
assert.equal(stingingNettle.foliage.whorlSize, 2, 'nettle foliage must grow as opposite pairs');
assert.equal(stingingNettle.foliage.rotate, 90, 'successive nettle pairs must be decussate');

assertTextureSet('fern', 'leaves', 'fern', ['albedo', 'normal', 'roughness', 'translucency']);
assert.equal(
  existsSync(`${assetRoot}bark/fern_branch_albedo.png`),
  false,
  'fern rachis belongs to the alpha-cutout frond and must not borrow a bark set',
);
assertGlb('bilberry_berry.glb');
assertGlb('juniper_berry.glb');
assertGlb('raspberry_cluster.glb');

console.log('SeedThree shrub texture ownership tests passed.');

function assertTextureSet(owner, folder, base, maps) {
  for (const map of maps) {
    const path = `${assetRoot}${folder}/${base}_${map}.png`;
    assert.ok(existsSync(path), `${owner} is missing its own ${base}_${map}.png`);
    if (map !== 'albedo') continue;
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    assert.equal(
      albedoOwners.get(hash),
      undefined,
      `${owner} reuses ${albedoOwners.get(hash) ?? 'another species'}'s ${folder} albedo bytes`,
    );
    albedoOwners.set(hash, `${owner} ${folder}`);
  }
}

function assertGlb(fileName) {
  const path = `${assetRoot}fruits/${fileName}`;
  assert.ok(existsSync(path), `${fileName} must exist as a dedicated fruit model`);
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'glTF', `${fileName} must be a binary glTF`);
}

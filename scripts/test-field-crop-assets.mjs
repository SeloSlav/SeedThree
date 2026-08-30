import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  FIELD_CROP_SPECIES,
  fieldBarley,
  fieldFlax,
  fieldMaslin,
  fieldOats,
  fieldRye,
} from '../src/species/field-crops.js';
import {
  createFieldCropGeometry,
  fieldCropComponents,
} from '../src/core/field-crops.js';

const root = process.cwd();
const textureStems = [
  'field_cereal_young',
  'field_flax_young',
  'field_rye',
  'field_oats',
  'field_barley',
  'field_flax',
  'maslin_wheat_component',
];

assert.deepEqual(Object.keys(FIELD_CROP_SPECIES), ['rye', 'oats', 'barley', 'flax', 'maslin']);
assert.equal(FIELD_CROP_SPECIES.wheat, undefined);
assert.deepEqual(
  [fieldRye.latin, fieldOats.latin, fieldBarley.latin, fieldFlax.latin],
  ['Secale cereale', 'Avena sativa', 'Hordeum vulgare', 'Linum usitatissimum'],
);
assert.deepEqual(
  fieldCropComponents(fieldMaslin).map(({ preset, share }) => [preset.key, share]),
  [['maslin-wheat-component', 0.62], ['rye', 0.38]],
);

for (const preset of [fieldRye, fieldOats, fieldBarley, fieldFlax]) {
  assert.ok(preset.young.referenceHeightMeters < preset.mature.referenceHeightMeters);
  for (const maturity of [0, 1]) {
    const geometry = createFieldCropGeometry(preset, maturity);
    assert.ok(geometry.getAttribute('position').count >= 8);
    assert.equal(geometry.getAttribute('uv').count, geometry.getAttribute('position').count);
    geometry.dispose();
  }
}

for (const stem of textureStems) {
  const albedoPath = join(root, 'assets', 'crops', `${stem}_albedo.png`);
  assert.ok(existsSync(albedoPath), `${stem} albedo must exist`);
  const albedo = await sharp(albedoPath).metadata();
  assert.ok(albedo.hasAlpha, `${stem} albedo must retain cutout alpha`);
  assert.ok((albedo.width ?? 0) >= 1024 && (albedo.height ?? 0) >= 1536);
  const stats = await sharp(albedoPath).stats();
  const alpha = stats.channels[3];
  assert.ok(alpha && alpha.min === 0 && alpha.max >= 250, `${stem} alpha must span transparent to opaque`);
  for (const suffix of ['normal', 'roughness', 'translucency']) {
    const path = join(root, 'assets', 'crops', `${stem}_${suffix}.png`);
    assert.ok(existsSync(path), `${stem} ${suffix} must exist`);
    const metadata = await sharp(path).metadata();
    assert.equal(metadata.width, albedo.width);
    assert.equal(metadata.height, albedo.height);
  }
}

console.log('SeedThree field-crop assets passed.');


// Reusable SeedThree crop-card runtime. Field topology and agricultural state
// stay application-owned; this module turns crop presets into rooted PBR cards.

import {
  createCardClumpGeometry,
  createGroundCoverMaterial,
} from './ground-cover.js';

export function fieldCropPhase(preset, maturity) {
  if (!preset || preset.category !== 'field-crop') {
    throw new Error('fieldCropPhase requires one SeedThree field-crop preset');
  }
  return Number.isFinite(maturity) && maturity >= 0.42 ? preset.mature : preset.young;
}

export function createFieldCropGeometry(preset, maturity = 1) {
  return createCardClumpGeometry(fieldCropPhase(preset, maturity).card);
}

export function createFieldCropMaterial(preset, textures, options = {}) {
  return createGroundCoverMaterial({
    name: `SeedThree ${preset.name}`,
    textures,
    transmit: preset.transmit,
    windAmount: preset.windAmount,
    alphaTest: 0.28,
    ...options,
  });
}

export function fieldCropComponents(preset) {
  if (preset?.category === 'field-crop-mixture') return preset.components;
  if (preset?.category === 'field-crop') return [{ preset, share: 1 }];
  throw new Error('fieldCropComponents requires a SeedThree field-crop preset');
}


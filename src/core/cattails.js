// Cattail/reed card preset. SeedThree owns the plant asset and rendering
// primitive; applications decide where their wetland/shoreline habitat is.

import {
  createCardClumpGeometry,
  createGroundCoverMaterial,
} from './ground-cover.js';

export const CATTAIL_TEXTURE_FILES = {
  albedo: 'cattail_reed_card.png',
  normal: 'cattail_reed_card_normal.png',
  roughness: 'cattail_reed_card_roughness.png',
  translucency: 'cattail_reed_card_translucency.png',
};

export const CATTAIL_CARD_SPEC = {
  quads: 4,
  width: 0.78,
  tiltMin: 0.025,
  tiltSpan: 0.12,
  heightMin: 0.9,
  heightSpan: 0.2,
  baseSpread: 0.08,
};

/** Average authored card height, used to convert physical metres to instance scale. */
export const CATTAIL_CARD_REFERENCE_HEIGHT = (
  CATTAIL_CARD_SPEC.heightMin + CATTAIL_CARD_SPEC.heightSpan * 0.5
);

/**
 * Typha latifolia commonly forms mixed-age stands: short first-year fans,
 * 1.4–2.3 m mature plants, and recurring 2–3 m stalks in the wettest ground.
 * Keeping the profile with the asset prevents consuming applications from
 * accidentally presenting every cattail as generic knee-high ground cover.
 */
export const CATTAIL_HEIGHT_PROFILE = Object.freeze({
  youngMinMeters: 0.7,
  youngMaxMeters: 1.15,
  matureMinMeters: 1.4,
  matureMaxMeters: 2.3,
  tallMinMeters: 2.2,
  tallMaxMeters: 3.05,
});

/**
 * Samples a physical clump height. `wetEdge` is normalized from 0 on the dry
 * fringe to 1 at the water line; wet ground supports more towering stalks,
 * while every habitat still retains visible age variation.
 */
export function sampleCattailHeightMeters(wetEdge, random = Math.random) {
  const wet = Math.max(0, Math.min(1, wetEdge));
  const youngChance = lerp(0.25, 0.08, wet);
  const tallChance = lerp(0.1, 0.32, wet);
  const cohortRoll = random();
  const heightRoll = random();

  if (cohortRoll < youngChance) {
    return lerp(
      CATTAIL_HEIGHT_PROFILE.youngMinMeters,
      CATTAIL_HEIGHT_PROFILE.youngMaxMeters,
      heightRoll,
    );
  }

  if (cohortRoll > 1 - tallChance) {
    return lerp(
      CATTAIL_HEIGHT_PROFILE.tallMinMeters,
      CATTAIL_HEIGHT_PROFILE.tallMaxMeters,
      Math.pow(heightRoll, 0.82),
    );
  }

  return lerp(
    CATTAIL_HEIGHT_PROFILE.matureMinMeters,
    CATTAIL_HEIGHT_PROFILE.matureMaxMeters,
    heightRoll,
  );
}

export function createCattailGeometry(overrides = {}) {
  return createCardClumpGeometry({ ...CATTAIL_CARD_SPEC, ...overrides });
}

export function createCattailMaterial(textures, options = {}) {
  return createGroundCoverMaterial({
    name: 'SeedThree cattails',
    textures,
    transmit: [0.28, 0.42, 0.13],
    windAmount: 0.22,
    ...options,
  });
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

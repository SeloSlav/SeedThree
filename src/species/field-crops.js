// Historic field-crop presets for application-owned parcel placement.
// SeedThree owns species identity, physical scale, growth-card selection and
// texture/PBR provenance; consuming games own field layout and simulation.

const cerealYoung = {
  albedo: 'field_cereal_young_albedo.png',
  normal: 'field_cereal_young_normal.png',
  roughness: 'field_cereal_young_roughness.png',
  translucency: 'field_cereal_young_translucency.png',
};

const cropTextures = (stem) => ({
  albedo: `${stem}_albedo.png`,
  normal: `${stem}_normal.png`,
  roughness: `${stem}_roughness.png`,
  translucency: `${stem}_translucency.png`,
});

const cerealCard = Object.freeze({
  quads: 2,
  width: 0.64,
  tiltMin: 0.015,
  tiltSpan: 0.045,
  heightMin: 0.96,
  heightSpan: 0.08,
  baseSpread: 0.035,
});

const flaxCard = Object.freeze({
  quads: 2,
  width: 0.62,
  tiltMin: 0.012,
  tiltSpan: 0.038,
  heightMin: 0.97,
  heightSpan: 0.06,
  baseSpread: 0.028,
});

const cerealPreset = ({ key, name, latin, heightMeters, textureStem }) => Object.freeze({
  key,
  name,
  latin,
  category: 'field-crop',
  young: Object.freeze({
    textures: Object.freeze(cerealYoung),
    referenceHeightMeters: 0.36,
    card: cerealCard,
  }),
  mature: Object.freeze({
    textures: Object.freeze(cropTextures(textureStem)),
    referenceHeightMeters: heightMeters,
    card: cerealCard,
  }),
  windAmount: 0.09,
  transmit: Object.freeze([0.34, 0.46, 0.15]),
});

export const fieldRye = cerealPreset({
  key: 'rye',
  name: 'Field Rye',
  latin: 'Secale cereale',
  heightMeters: 1.42,
  textureStem: 'field_rye',
});

export const fieldOats = cerealPreset({
  key: 'oats',
  name: 'Common Oats',
  latin: 'Avena sativa',
  heightMeters: 1.06,
  textureStem: 'field_oats',
});

export const fieldBarley = cerealPreset({
  key: 'barley',
  name: 'Hulled Barley',
  latin: 'Hordeum vulgare',
  heightMeters: 0.91,
  textureStem: 'field_barley',
});

export const fieldFlax = Object.freeze({
  key: 'flax',
  name: 'Fibre Flax',
  latin: 'Linum usitatissimum',
  category: 'field-crop',
  young: Object.freeze({
    textures: Object.freeze(cropTextures('field_flax_young')),
    referenceHeightMeters: 0.42,
    card: flaxCard,
  }),
  mature: Object.freeze({
    textures: Object.freeze(cropTextures('field_flax')),
    referenceHeightMeters: 0.88,
    card: flaxCard,
  }),
  windAmount: 0.075,
  transmit: Object.freeze([0.28, 0.42, 0.18]),
});

// The game crop key `wheat` denotes maslin. This component is deliberately not
// exported as a standalone crop: it only appears inside the mixed maslin preset.
const maslinWheatComponent = cerealPreset({
  key: 'maslin-wheat-component',
  name: 'Maslin Wheat Component',
  latin: 'Triticum aestivum',
  heightMeters: 1.22,
  textureStem: 'maslin_wheat_component',
});

export const fieldMaslin = Object.freeze({
  key: 'maslin',
  name: 'Wheat–Rye Maslin',
  category: 'field-crop-mixture',
  components: Object.freeze([
    Object.freeze({ preset: maslinWheatComponent, share: 0.62 }),
    Object.freeze({ preset: fieldRye, share: 0.38 }),
  ]),
});

export const FIELD_CROP_SPECIES = Object.freeze({
  rye: fieldRye,
  oats: fieldOats,
  barley: fieldBarley,
  flax: fieldFlax,
  maslin: fieldMaslin,
});


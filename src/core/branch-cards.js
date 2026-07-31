// Baked branch cards — billboard-cloud / SpeedTree-Clusters style intermediate
// LOD foliage, baked FROM THE LOD0 TREE ITSELF (per the AAA pipeline research:
// HZD's authored clusters, Simplygon/InstaLOD's automated billboard clouds).
//
// A few exemplar terminal subtrees (twig cylinder + its real LOD0 leaf
// instances, real leaf material) are rendered through the multichannel baker
// into unlit material inputs (albedo/normal/rough/translucency). At LOD1+ every
// terminal twig — cylinder AND leaves — is replaced by ONE single-quad card
// instance using those bakes, placed with the branch's own frame. Species can
// request a bounded, bake-only coverage cohort: it fills projection holes in
// leaf-heavy crowns while preserving the original cohort and adding no runtime
// cards, draws, or triangles. The card remains a picture of real SeedThree
// foliage relit by the same material family.
//
// Bakes are cached per (species, leaf params) in main.js — they're built from a
// FIXED exemplar seed, so reseeding the tree reuses them.

import {
  Group, Mesh, InstancedMesh, BufferGeometry, BufferAttribute, InstancedBufferAttribute,
  OrthographicCamera, Box3, Vector3, Quaternion, Matrix4, Color, DoubleSide, MeshSSSNodeMaterial,
} from 'three/webgpu';
import {
  texture, uniform, positionWorld, attribute, cameraViewMatrix, vec3, vec4, float, mix, luminance, sin, step,
} from 'three/tsl';
import { Rng } from './rng.js';
import { generateSkeleton } from './weber-penn.js';
import { buildBranchGeometry } from './branch-mesh.js';
import { buildFoliage, addThicknessAttribute } from './leaf-cards.js';
import { bakeGroupToTextures } from './impostor.js';
import { foliageWindPosition, sunDirectionUniform, WIND_DIR } from './wind.js';

const MAX_CARD_INSTANCES = 4096; // aThickness allocation on the shared geometry
const TRANSMIT = [0.42, 0.62, 0.24];
const SEASONAL_TREE_ORIGIN_Y_OFFSET = 2048;

// Consumers with persistent branch-card atlases should include this revision in
// their cache key. Revision 2 adds the bounded coverage cohort below.
export const BRANCH_CARD_BAKE_REVISION = 2;
export const BRANCH_CARD_COVERAGE_DEFAULTS = Object.freeze({
  maxCoverage: 2,
  // Temporary bake-source cost only. With the default crossed-leaf geometry
  // this permits at most 512 extra leaves / 2,048 extra triangles per exemplar.
  extraTriangleBudget: 2048,
});

const chordVec = (stem, out) =>
  out.copy(stem.points[stem.points.length - 1]).sub(stem.points[0]);

// Arc length (sum of segments) — the STABLE size reference for card scaling. The
// straight-line CHORD collapses toward 0 on short curved twigs (tip curves back over
// the base), which made `len/chordLen` explode → cards baked 10-30× too big.
function stemArcLen(stem) {
  let l = 0; const p = stem.points;
  for (let i = 1; i < p.length; i++) l += p[i].distanceTo(p[i - 1]);
  return l;
}

/**
 * Plan a second, deterministic leaf cohort used only while rasterizing a branch
 * card. `foliage.cardCoverage` is a perceived-coverage target, not a runtime
 * density multiplier: the original leaves are built first with their unchanged
 * RNG stream, then this many fill leaves are baked into the same atlas.
 *
 * Extra geometry is bounded in triangles per exemplar. The result deliberately
 * reports runtimeCardInstancesAdded=0 so hosts can expose/verify the cost model.
 */
export function planBranchCardCoverage(foliage = {}, terminalStemCount = 0, opts = {}) {
  const stems = Math.max(
    0,
    Math.floor(Number.isFinite(terminalStemCount) ? terminalStemCount : 0),
  );
  const baseLeavesPerBranch = Math.max(
    0,
    Math.round(Number.isFinite(foliage.leavesPerBranch) ? foliage.leavesPerBranch : 14),
  );
  const quads = Math.max(
    1,
    Math.round(Number.isFinite(foliage.quads) ? foliage.quads : 2),
  );
  const trianglesPerLeaf = quads * 2;
  const rawCoverage = opts.coverage ?? foliage.cardCoverage ?? 1;
  const coverage = Math.min(
    BRANCH_CARD_COVERAGE_DEFAULTS.maxCoverage,
    Math.max(1, Number.isFinite(rawCoverage) ? rawCoverage : 1),
  );
  const requestedLeavesPerBranch = Math.max(
    baseLeavesPerBranch,
    Math.round(baseLeavesPerBranch * coverage),
  );
  const extraTriangleBudget = Math.max(
    0,
    Math.floor(Number.isFinite(opts.extraTriangleBudget)
      ? opts.extraTriangleBudget
      : BRANCH_CARD_COVERAGE_DEFAULTS.extraTriangleBudget),
  );
  const requestedExtraLeavesPerBranch = requestedLeavesPerBranch - baseLeavesPerBranch;
  const affordableExtraLeavesPerBranch = stems > 0
    ? Math.floor(extraTriangleBudget / (stems * trianglesPerLeaf))
    : 0;
  const extraLeavesPerBranch = Math.max(
    0,
    Math.min(requestedExtraLeavesPerBranch, affordableExtraLeavesPerBranch),
  );
  const sourceLeafInstances = stems * baseLeavesPerBranch;
  const requestedLeafInstances = stems * requestedLeavesPerBranch;
  const extraBakeLeafInstances = stems * extraLeavesPerBranch;
  const extraBakeTriangles = extraBakeLeafInstances * trianglesPerLeaf;

  return {
    bakeRevision: BRANCH_CARD_BAKE_REVISION,
    terminalStemCount: stems,
    baseLeavesPerBranch,
    requestedLeavesPerBranch,
    extraLeavesPerBranch,
    sourceLeafInstances,
    requestedLeafInstances,
    bakeLeafInstances: sourceLeafInstances + extraBakeLeafInstances,
    extraBakeLeafInstances,
    trianglesPerLeaf,
    extraBakeTriangles,
    extraTriangleBudget,
    coverageRequested: Number.isFinite(rawCoverage) ? rawCoverage : 1,
    coverageApplied: coverage,
    coverageRealized: baseLeavesPerBranch > 0
      ? (baseLeavesPerBranch + extraLeavesPerBranch) / baseLeavesPerBranch
      : 1,
    budgetLimited: extraLeavesPerBranch < requestedExtraLeavesPerBranch,
    runtimeCardInstancesAdded: 0,
  };
}

// Rebase a stem into card-local space: base at the origin, chord along +Y —
// the same frame the card quad and its placement transform use.
function rebaseStem(stem) {
  const base = stem.points[0];
  const chord = chordVec(stem, new Vector3()).normalize();
  const q = new Quaternion().setFromUnitVectors(chord, new Vector3(0, 1, 0));
  return {
    ...stem,
    points: stem.points.map((p) => p.clone().sub(base).applyQuaternion(q)),
    orients: stem.orients.map((o) => q.clone().multiply(o)),
  };
}

// parentId → [children] index over a flat stem list (see weber-penn topology).
function childrenMap(stems) {
  const m = new Map();
  for (const s of stems) {
    if (s.parentId == null || s.parentId < 0) continue;
    let a = m.get(s.parentId); if (!a) m.set(s.parentId, a = []);
    a.push(s);
  }
  return m;
}

// A root stem + every descendant (branch + its twigs), gathered depth-first.
function subtreeOf(root, byParent) {
  const out = [root];
  const stack = [root.id];
  while (stack.length) {
    const kids = byParent.get(stack.pop());
    if (!kids) continue;
    for (const k of kids) { out.push(k); stack.push(k.id); }
  }
  return out;
}

// Rebase a WHOLE subtree by ONE shared frame (the root's base/chord), so the
// limb keeps its internal shape but sits base-at-origin, chord-up — the frame
// the placed card is scaled/oriented in. On a curled root whose chord collapses,
// fall back to the base-segment tangent so the whole limb isn't flung sideways.
function rebaseSubtree(subtree, root) {
  const base = root.points[0];
  const chord = chordVec(root, new Vector3());
  if (chord.lengthSq() < 1e-6) chord.copy(root.points[1]).sub(root.points[0]);
  chord.normalize();
  const q = new Quaternion().setFromUnitVectors(chord, new Vector3(0, 1, 0));
  return subtree.map((s) => ({
    ...s,
    points: s.points.map((p) => p.clone().sub(base).applyQuaternion(q)),
    orients: s.orients.map((o) => q.clone().multiply(o)),
  }));
}

// Single quad spanning the bake framing, in the SAME stem-local space (origin =
// stem base) so instance transforms are just (base position, chord rotation, scale).
function cardQuadGeometry(center, halfW, halfH) {
  const geo = new BufferGeometry();
  const x0 = center.x - halfW, x1 = center.x + halfW;
  const y0 = center.y - halfH, y1 = center.y + halfH;
  geo.setAttribute('position', new BufferAttribute(new Float32Array([
    x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0,
  ]), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1,
  ]), 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

// Same material family + dome-normal blend as LOD0 leaves — matched diffuse
// response across the LOD switch is what hides the pop (proxy-normal transfer).
function makeCardMaterial(t, centerUniform, opts = {}) {
  const mat = new MeshSSSNodeMaterial({
    map: t.albedo, normalMap: t.normal, roughnessMap: t.rough,
    alphaTest: 0.35, side: DoubleSide, roughness: 1.0, metalness: 0.0,
  });
  // Canopy-sphere field evaluated from WORLD position via cameraViewMatrix —
  // NOT transformNormalToView, which applies each instance's rotation and makes
  // neighboring crossed cards disagree about the dome (crosshatch shadowing).
  // Same construction as the billboard cards. Baked world-space normals ride
  // on top as additive per-pixel detail.
  const base = positionWorld.sub(centerUniform).normalize().add(vec3(0, 0.45, 0)); // up-bias: never point down
  const detail = texture(t.normal).xyz.mul(2).sub(1);
  const nWorld = base.add(detail.mul(0.45)).normalize();
  mat.normalNode = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize();
  // Same canopy sway as the leaves; noFlutter for CROSSED (limb) card sets — the
  // random-phase flutter tears a crossed pair apart at the seam (see wind.js).
  mat.positionNode = foliageWindPosition(!opts.noFlutter);
  const transmit = uniform(new Color().setRGB(...TRANSMIT));
  mat.thicknessColorNode = texture(t.trans).r.mul(attribute('aThickness', 'float')).mul(transmit);
  mat.thicknessDistortionNode = uniform(0.3);
  mat.thicknessAmbientNode = uniform(0.16); // scatter floor — see leaf-cards.js
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(6.0);
  mat.thicknessScaleNode = uniform(3.0);
  mat.userData.gltfDiffuseTransmission = { factor: 1.0, color: TRANSMIT, map: t.trans };
  return mat;
}

/**
 * Bake 2-4 exemplar branch cards for a species, rooted at a chosen branch level.
 * Caller must pause its animation loop (renderer is re-targeted).
 *
 * @param {object} species  shaped species preset (params + foliage reflect GUI)
 * @param {object} assets   cached species assets (barkMat, leafMat, ...)
 * @param {object} opts     { size, variants, cardLevel, coverage,
 *                          extraTriangleBudget } — cardLevel defaults to the
 *                          deepest level (per-twig cards); lower levels bake a
 *                          whole limb (branch + twigs + leaves) into one card.
 * @returns {Promise<{variants: Array, centerUniform} | null>}
 */
export async function bakeBranchCards(renderer, species, assets, opts = {}) {
  if (!assets.leafMat || !assets.barkMat) return null;
  const variantCount = opts.variants ?? 3;
  const size = opts.size ?? 512;

  // Fixed exemplar seed → deterministic cards independent of the live tree seed.
  const rng = new Rng(`${species.name}:cards`);
  const { stems } = generateSkeleton(species.params, rng);
  const v = new Vector3();
  // Which branch level roots each card. Default = the deepest level (terminal
  // twigs → one card per twig, the classic hybrid LOD). A LOWER cardLevel bakes a
  // whole LIMB (branch + all its twigs + leaves) into ONE card, so reduced/mobile
  // LODs can DELETE that limb's geometry and show a single billboard of it — the
  // AAA "curve toward impostor" (each rung down bakes a bigger slice of the tree).
  const maxLevel = stems[0]?.maxLevel ?? 0;
  const cardLevel = opts.cardLevel ?? maxLevel;
  const byParent = childrenMap(stems);
  const roots = stems.filter((s) => s.level === cardLevel && s.points.length >= 2 && chordVec(s, v).lengthSq() > 1e-4);
  if (!roots.length) return null;

  // Exemplars from spread ARC-length percentiles — variety without atlas bloat.
  // (Arc length, not chord — the chord collapses on curved twigs; see stemArcLen.)
  const sorted = [...roots].sort((a, b) => stemArcLen(a) - stemArcLen(b));
  const picks = [0.25, 0.45, 0.65, 0.85].slice(0, Math.min(variantCount, 4))
    .map((f) => sorted[Math.floor(f * (sorted.length - 1))]);

  const centerUniform = uniform(new Vector3());
  const thicknessRng = new Rng(`${species.name}:cards:thickness`);
  const variants = [];
  const coverageTelemetry = [];
  for (const [vi, stem] of picks.entries()) {
    // The exemplar is the root's WHOLE subtree, rebased by the root frame. At the
    // default (terminal) level the subtree is just the twig itself, so this stays
    // identical to the old per-twig bake.
    const sub = rebaseSubtree(subtreeOf(stem, byParent), stem);
    const subTerminals = sub.filter((s) => s.level === maxLevel);
    const group = new Group();
    // foliageOnly: bake LEAVES only, no twig tube in the card. For hybrid levels
    // that KEEP the real twig skeleton (keepTwigs), a card with the tube baked in
    // duplicates every twig — a cylinder AND a picture of that cylinder side by
    // side (glaring at the mobile near view). Collapse levels, whose real tubes
    // are deleted, bake the full twig+leaves content.
    let twigGeo = null;
    if (!opts.foliageOnly) {
      twigGeo = buildBranchGeometry(sub, { tileWorldSize: species.tileWorldSize ?? 1.5 });
      group.add(new Mesh(twigGeo, assets.barkMat));
    }
    const frng = new Rng(`${species.name}:cards:${vi}`);
    // trunkClearRadius culls leaves near the WORLD axis (the real trunk). The exemplar
    // cluster is rebased to the ORIGIN, so leaving it on would cull the ENTIRE cluster
    // (every leaf sits within the radius of x=z=0) → empty cards (the red maple forest
    // "no leaves" bug). It only makes sense against the actual trunk, so force it off here.
    // FOLIAGE-ONLY cards bake their leaves on a STRAIGHTENED twig. The exemplar's
    // random curve put the leaf mass off the chord axis in a direction unrelated
    // to whatever real twig the card lands on — leaves floated in the air beside
    // their branch. (Full-content cards hid this: the baked tube moved WITH its
    // leaves.) Straight along the chord, the leaves hug the real twig underneath
    // — which the mobile near LOD decimates to its chord anyway.
    const leafStems = subTerminals.length ? subTerminals : sub;
    const bakeStems = !opts.foliageOnly ? leafStems : leafStems.map((s) => {
      let acc = 0;
      const pts = s.points.map((p, j) => { if (j > 0) acc += p.distanceTo(s.points[j - 1]); return new Vector3(0, acc, 0); });
      return { ...s, points: pts, orients: s.orients.map(() => new Quaternion()) };
    });
    const foliageCfg = {
      ...(species.foliage || {}),
      mode: 'leaves',
      trunkClearRadius: 0,
    };
    // Build the original cohort first with the exact pre-revision seed/stream.
    // The fill cohort has its own stable seed, so enabling coverage cannot move
    // or reorient any existing leaf; it only adds overlap inside the same twig
    // envelope. Both meshes are temporary and disappear after rasterization.
    const leaves = buildFoliage(bakeStems, foliageCfg, frng, assets.leafMat, null);
    if (leaves) group.add(leaves);
    const coveragePlan = planBranchCardCoverage(foliageCfg, bakeStems.length, {
      coverage: opts.coverage,
      extraTriangleBudget: opts.extraTriangleBudget,
    });
    let coverageLeaves = null;
    if (coveragePlan.extraLeavesPerBranch > 0) {
      const coverageRng = new Rng(
        `${species.name}:cards:${vi}:coverage-v${BRANCH_CARD_BAKE_REVISION}`,
      );
      coverageLeaves = buildFoliage(
        bakeStems,
        { ...foliageCfg, leavesPerBranch: coveragePlan.extraLeavesPerBranch },
        coverageRng,
        assets.leafMat,
        null,
      );
      if (coverageLeaves) group.add(coverageLeaves);
    }
    coverageTelemetry.push({
      variantIndex: vi,
      cardLevel,
      foliageOnly: !!opts.foliageOnly,
      ...coveragePlan,
    });
    if (!group.children.length) {
      // Even an empty foliage-only exemplar may have allocated its source
      // geometry before filtering produced no renderable children.
      twigGeo?.dispose();
      if (leaves) leaves.geometry.dispose();
      if (coverageLeaves) coverageLeaves.geometry.dispose();
      continue;
    }

    if (leaves) leaves.computeBoundingBox?.();
    if (coverageLeaves) coverageLeaves.computeBoundingBox?.();
    const box = new Box3().setFromObject(group);
    const center = box.getCenter(new Vector3());
    const sz = box.getSize(new Vector3());
    const halfW = (Math.max(sz.x, sz.z) / 2) * 1.02;
    const halfH = (sz.y / 2) * 1.02;
    const depth = Math.max(sz.x, sz.z) + 2;
    const cam = new OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, depth * 2);
    cam.position.set(center.x, center.y, center.z + depth);
    cam.lookAt(center);

    let baked;
    try {
      baked = (await bakeGroupToTextures(
        renderer,
        group,
        [{ name: 'card', camera: cam }],
        { size, dilate: 10 },
      )).card;
    } finally {
      // Bake-only geometry must be released even if GPU rendering/readback
      // rejects. The card quad created below is the only cached geometry.
      twigGeo?.dispose();
      if (leaves) leaves.geometry.dispose();
      if (coverageLeaves) coverageLeaves.geometry.dispose();
    }

    const geometry = cardQuadGeometry(center, halfW, halfH);
    geometry.userData.shared = true; // disposeTree must NOT free cached card geometry
    addThicknessAttribute(geometry, MAX_CARD_INSTANCES, thicknessRng);
    // per-instance wind heading×weight + anchor point (sway phase) — values
    // written per rebuild by buildCardFoliage. Weight is PACKED into aWindVec:
    // WebGPU caps pipelines at 8 vertex buffers and the forest twin (which
    // adds aTreeOrigin) sits exactly at that limit.
    geometry.setAttribute('aWindVec', new InstancedBufferAttribute(new Float32Array(MAX_CARD_INSTANCES * 3), 3));
    geometry.setAttribute('aAnchorPos', new InstancedBufferAttribute(new Float32Array(MAX_CARD_INSTANCES * 3), 3));
    variants.push({
      geometry,
      material: makeCardMaterial(baked, centerUniform, { noFlutter: opts.noFlutter }),
      textures: baked,
      chordLen: stemArcLen(stem), // ARC length (stable), not the collapsing chord
    });
  }
  if (!variants.length) return null;
  return {
    variants,
    centerUniform,
    foliageOnly: !!opts.foliageOnly,
    telemetry: {
      bakeRevision: BRANCH_CARD_BAKE_REVISION,
      coverage: coverageTelemetry,
      sourceLeafInstances: coverageTelemetry.reduce(
        (sum, item) => sum + item.sourceLeafInstances,
        0,
      ),
      extraBakeLeafInstances: coverageTelemetry.reduce(
        (sum, item) => sum + item.extraBakeLeafInstances,
        0,
      ),
      extraBakeTriangles: coverageTelemetry.reduce(
        (sum, item) => sum + item.extraBakeTriangles,
        0,
      ),
      runtimeCardInstancesAdded: 0,
    },
  };
}

/**
 * Place one baked card per terminal stem (variant round-robin, random roll
 * about the branch axis). LOD2 passes keepFraction < 1 + a bigger growScale —
 * the SpeedTree "fewer and bigger" volume-preserving reduction.
 *
 * @returns {Group} one InstancedMesh per variant
 */
export function buildCardFoliage(terminalStems, cards, rng, opts = {}) {
  const grow = opts.growScale ?? 1.2;
  const keep = opts.keepFraction ?? 1;
  // Whole-limb cards (mobile far rungs) place a CROSSED PAIR per limb, like the
  // final billboard. One flat quad per TWIG can vanish edge-on because hundreds of
  // neighbours at random rolls cover for it — but a lone LIMB card IS the canopy
  // where it stands, so edge-on it left a bare pole with streaks. The 90° twin
  // keeps the limb readable from every azimuth for +2 tris per limb.
  const copies = opts.crossed ? 2 : 1;
  const { variants, centerUniform } = cards;
  if (!terminalStems.length || !variants.length) return null;

  // Dome origin at the canopy BOTTOM (same convention as leaf materials — a
  // mid-canopy origin gives downward dome normals below it → black underside).
  const center = new Vector3();
  let minY = Infinity;
  for (const s of terminalStems) {
    center.add(s.points[s.points.length - 1]);
    for (const p of s.points) minY = Math.min(minY, p.y);
  }
  center.divideScalar(terminalStems.length);
  centerUniform.value.set(center.x, Math.min(minY - 0.5, center.y - 1), center.z);

  // Bucket each terminal to the NEAREST-SIZE exemplar (by arc length), so the placement
  // scale s = liveArc/exemplarArc stays ~1 and the baked LEAVES don't get scaled up.
  // Round-robin bucketing put long terminals on short-exemplar cards → s up to 4× →
  // giant leaves. Nearest-match keeps every card's leaves ~their true (LOD0) size.
  const buckets = variants.map(() => []);
  for (const stem of terminalStems) {
    if (keep < 1 && rng.next() > keep) continue;
    const a = stemArcLen(stem);
    let best = 0, bestD = Infinity;
    for (let vi = 0; vi < variants.length; vi++) { const d = Math.abs(a - variants[vi].chordLen); if (d < bestD) { bestD = d; best = vi; } }
    buckets[best].push(stem);
  }

  const group = new Group();
  group.name = 'foliage';
  const m = new Matrix4();
  const q = new Quaternion();
  const qRoll = new Quaternion();
  const pos = new Vector3();
  const scl = new Vector3();
  const chord = new Vector3();
  const Y = new Vector3(0, 1, 0);

  for (const [vi, list] of buckets.entries()) {
    if (!list.length) continue;
    const variant = variants[vi];
    const mesh = new InstancedMesh(variant.geometry, variant.material, list.length * copies);
    mesh.name = `cards${vi}`;
    const windVecAttr = variant.geometry.attributes.aWindVec;
    const anchorAttr = variant.geometry.attributes.aAnchorPos;
    const weights = new Float32Array(list.length * copies); // CPU copy for the forest rebinner
    const qChord = new Quaternion();
    const qInv = new Quaternion();
    const wv = new Vector3();
    let k = 0;
    for (const stem of list) {
      // Sway weight: a per-twig card anchors near the tips, so its BASE weight is
      // already tip-like. A CROSSED limb card replaces the limb's whole canopy —
      // swaying it by the limb root's stiff base weight froze LOD2 while the
      // nearer LODs waved (the wind "mostly stopped" bug). Use the root's TIP
      // weight so the card moves like the foliage it stands in for.
      const weight = (copies > 1)
        ? (stem.winds?.[stem.winds.length - 1] ?? stem.winds?.[0] ?? 0.6)
        : (stem.winds?.[0] ?? 0.6);
      pos.copy(stem.points[0]);
      chordVec(stem, chord);
      const chordLen = chord.length();
      const refLen = stemArcLen(stem);      // stable size ref (chord collapses on curved twigs)
      if (refLen < 1e-3) continue;
      // Orient along the chord when it's meaningful; on a curled twig whose chord
      // nearly vanishes, fall back to the base-segment tangent so the card isn't
      // wildly mis-aimed (and, crucially, isn't scaled by a near-zero chord).
      if (chordLen > 0.15 * refLen) qChord.setFromUnitVectors(Y, chord.divideScalar(chordLen));
      else qChord.setFromUnitVectors(Y, chord.copy(stem.points[1]).sub(stem.points[0]).normalize());
      const roll = rng.range(0, Math.PI * 2); // roll about the branch axis
      // Arc-length ratio → ~1 (× grow). FOLIAGE-ONLY cards clamp the ratio hard:
      // the card scales its LEAVES with it, and at the mobile NEAR view a long
      // twig on a short exemplar reads as giant leaves (beech's wide twig-length
      // spread). Leaf size is sacred; a slightly short/long leaf run along the
      // twig is invisible next to wrong-sized leaves.
      let s = (refLen / variant.chordLen) * grow;
      if (cards.foliageOnly) s = Math.min(1.15, Math.max(0.75, s));
      scl.set(s, s, s);
      for (let ci = 0; ci < copies; ci++) { // crossed pair: twin at 90°
        qRoll.setFromAxisAngle(Y, roll + ci * Math.PI / 2);
        q.copy(qChord).multiply(qRoll);
        // wind heading×weight in card-local space + anchor for sway phase (wind.js)
        qInv.copy(q).invert();
        wv.copy(WIND_DIR).applyQuaternion(qInv).multiplyScalar(weight / s);
        windVecAttr.setXYZ(k, wv.x, wv.y, wv.z);
        anchorAttr.setXYZ(k, pos.x, pos.y, pos.z);
        weights[k] = weight;
        m.compose(pos, q, scl);
        mesh.setMatrixAt(k++, m);
      }
    }
    mesh.count = k;
    mesh.userData.windWeights = weights;
    mesh.instanceMatrix.needsUpdate = true;
    windVecAttr.needsUpdate = true;
    anchorAttr.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group.children.length ? group : null;
}

// Forest twin of a card material: identical look, but the canopy-dome normal
// reads its origin from a PER-INSTANCE attribute (aTreeOrigin) instead of the
// hero tree's uniform — otherwise every forest tree shades as if its leaves
// belonged to one giant canopy centred on the hero (the lighting mismatch).
// Cached per source material so rebuilds don't recompile.
const forestMats = new WeakMap();
export function forestCardMaterial(srcMat, opts = {}) {
  const tintKey = opts.canopyTint?.join(',') ?? 'none';
  const autumnKey = opts.autumnColor?.join(',') ?? 'none';
  const cacheKey = `${opts.seasonalDeciduous ? 'seasonal' : 'standard'}:${tintKey}:${autumnKey}:${opts.toneVariation ?? 0}`;
  let variants = forestMats.get(srcMat);
  if (!variants) {
    variants = new Map();
    forestMats.set(srcMat, variants);
  }
  let mat = variants.get(cacheKey);
  if (mat) return mat;
  mat = new MeshSSSNodeMaterial({
    map: srcMat.map, normalMap: srcMat.normalMap, roughnessMap: srcMat.roughnessMap,
    alphaTest: srcMat.alphaTest, side: DoubleSide, roughness: 1.0, metalness: 0.0,
  });
  // The deciduous instance bit rides in aTreeOrigin.y because forest cards
  // already consume WebGPU's portable maximum of eight vertex buffers.
  const packedTreeOrigin = attribute('aTreeOrigin', 'vec3');
  const deciduousInstance = step(float(1024), packedTreeOrigin.y);
  const treeOrigin = vec3(
    packedTreeOrigin.x,
    packedTreeOrigin.y.sub(deciduousInstance.mul(SEASONAL_TREE_ORIGIN_Y_OFFSET)),
    packedTreeOrigin.z,
  );
  const base = positionWorld.sub(treeOrigin).normalize().add(vec3(0, 0.45, 0));
  const detail = srcMat.normalMap ? texture(srcMat.normalMap).xyz.mul(2).sub(1) : vec3(0, 0, 0);
  const nWorld = base.add(detail.mul(0.45)).normalize();
  mat.normalNode = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize();
  // Trees INSIDE the shadow frustum (world r < ~74) self-shadow with the real
  // map; beyond it no shadows exist, so the analytic sun-occlusion fades in by
  // world radius to carry the same look — one material, both regimes.
  const sunFacing = base.normalize().dot(sunDirectionUniform).mul(0.5).add(0.5);
  const analytic = sunFacing.pow(1.4).mul(0.78).add(0.22);
  const occl = mix(float(1), analytic, treeOrigin.xz.length().smoothstep(float(60), float(90)));
  const texel = texture(srcMat.map);
  const dtMap = srcMat.userData.gltfDiffuseTransmission?.map;
  let seasonalRetain = float(1);
  let surfaceColor = texel.rgb;
  if (opts.seasonalDeciduous) {
    // Branch-card bakes contain both green leaf pixels and, on collapsed LODs,
    // brown twig pixels. Key dormancy off green dominance rather than fading the
    // complete card: seasonal color and winter leaf drop affect only leaf
    // pixels on tree instances explicitly marked deciduous, retaining both the
    // baked structural twigs and evergreens sharing a larch proxy material.
    const springFlush = uniform(0);
    const autumnColor = uniform(0);
    const dormancy = uniform(0);
    const greenDominance = texel.g.sub(texel.r.max(texel.b));
    const greenLeafMask = greenDominance.smoothstep(float(0.015), float(0.08));
    // The bake's transmission channel is authored by the source leaves and is
    // absent on bark. It catches shadowed, neutral, and autumn-tinted leaf pixels
    // that a green-only key misses while still retaining brown structural twigs.
    const transmissionLeafMask = dtMap
      ? texture(dtMap).r.smoothstep(float(0.08), float(0.28))
      : float(0);
    const leafMask = greenLeafMask.max(transmissionLeafMask).mul(deciduousInstance);
    const value = luminance(texel.rgb);
    const springLeaf = vec3(0.72, 1, 0.32).mul(value.mul(1.25)).clamp(0, 1);
    const autumnPalette = opts.autumnColor ?? [0.94, 0.48, 0.08];
    const autumnLeaf = vec3(
      autumnPalette[0],
      autumnPalette[1],
      autumnPalette[2],
    ).mul(value.mul(1.45)).clamp(0, 1);
    surfaceColor = mix(
      surfaceColor,
      springLeaf,
      leafMask.mul(springFlush).mul(float(0.72)),
    );
    surfaceColor = mix(surfaceColor, autumnLeaf, leafMask.mul(autumnColor));
    const dormantMask = leafMask.mul(dormancy);
    const dormantEdge = vec3(value.mul(1.08), value.mul(0.82), value.mul(0.58)).clamp(0, 1);
    seasonalRetain = float(1).sub(dormantMask);
    surfaceColor = mix(surfaceColor, dormantEdge, dormantMask);
    mat.opacityNode = texel.a.mul(seasonalRetain);
    mat.userData.forestSeasonalSpringFlush = springFlush;
    mat.userData.forestSeasonalAutumnColor = autumnColor;
    mat.userData.forestSeasonalDormancy = dormancy;
  }
  if (opts.canopyTint || opts.toneVariation) {
    // Overview crowns share one material per species. Reuse the existing
    // per-instance tree origin for stable tonal breakup: this adds no attribute,
    // buffer upload, texture sample, or draw. Species tint keeps needle proxies
    // in the darker evergreen range instead of the bake's pale display green.
    const tint = opts.canopyTint
      ? vec3(opts.canopyTint[0], opts.canopyTint[1], opts.canopyTint[2])
      : vec3(1, 1, 1);
    const variation = opts.toneVariation
      ? sin(treeOrigin.x.mul(0.73).add(treeOrigin.z.mul(1.17)))
        .mul(float(opts.toneVariation))
        .add(1)
      : float(1);
    mat.colorNode = surfaceColor.mul(tint).mul(occl).mul(variation);
    if (!opts.seasonalDeciduous) mat.opacityNode = texel.a;
  } else if (opts.seasonalDeciduous) {
    mat.colorNode = surfaceColor.mul(occl);
  } else {
    mat.colorNode = texel.mul(vec4(occl, occl, occl, 1));
  }
  const transmit = uniform(new Color().setRGB(...TRANSMIT));
  mat.thicknessColorNode = (dtMap ? texture(dtMap).r : uniform(1))
    .mul(attribute('aThickness', 'float'))
    .mul(seasonalRetain)
    .mul(transmit);
  mat.thicknessDistortionNode = uniform(0.3);
  mat.thicknessAmbientNode = uniform(0.16);
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(6.0);
  mat.thicknessScaleNode = uniform(3.0);
  mat.positionNode = foliageWindPosition();
  variants.set(cacheKey, mat);
  return mat;
}

/** Updates a forest card's deciduous dormancy uniform without rebuilding it. */
export function setForestCardDormancy(material, amount) {
  const dormancy = material?.userData?.forestSeasonalDormancy;
  if (!dormancy) return false;
  const next = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0));
  if (dormancy.value === next) return false;
  dormancy.value = next;
  return true;
}

/** Updates color and leaf retention without rebuilding geometry or materials. */
export function setForestCardSeason(material, state = {}) {
  const spring = material?.userData?.forestSeasonalSpringFlush;
  const autumn = material?.userData?.forestSeasonalAutumnColor;
  const dormancy = material?.userData?.forestSeasonalDormancy;
  if (!spring || !autumn || !dormancy) return false;
  const clamp = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const nextSpring = clamp(state.springFlush);
  const nextAutumn = clamp(state.autumnColor);
  const nextDormancy = clamp(state.dormancy);
  let changed = false;
  if (spring.value !== nextSpring) {
    spring.value = nextSpring;
    changed = true;
  }
  if (autumn.value !== nextAutumn) {
    autumn.value = nextAutumn;
    changed = true;
  }
  if (dormancy.value !== nextDormancy) {
    dormancy.value = nextDormancy;
    changed = true;
  }
  return changed;
}

export function disposeBranchCards(cards) {
  // A facade may hold several per-level sets in `byLevel` (its `variants` alias the
  // deepest set, so iterate byLevel to avoid missing — or double-freeing — a set).
  const sets = cards.byLevel ? [...cards.byLevel.values()] : [cards];
  for (const set of sets) {
    for (const variant of set.variants) {
      for (const tex of Object.values(variant.textures)) tex.dispose();
      const cachedForestMaterials = forestMats.get(variant.material);
      if (cachedForestMaterials) {
        for (const material of cachedForestMaterials.values()) material.dispose();
        forestMats.delete(variant.material);
      }
      variant.material.dispose();
      variant.geometry.dispose();
    }
  }
}

/**
 * Resolves a low-cost shadow policy for dense alpha-cutout ground cover.
 *
 * When the underlying terrain already receives projected world shadows,
 * sampling the same atlas again on every grass/flower fragment adds substantial
 * fill cost while changing only the blade pixels. Consumers can still opt in
 * explicitly when no shadow-receiving ground surface exists.
 */
export function resolveGroundCoverShadowPolicy({
  castShadow = false,
  receiveShadow = 'auto',
  terrainReceivesShadow = true,
} = {}) {
  if (
    receiveShadow !== 'auto'
    && typeof receiveShadow !== 'boolean'
  ) {
    throw new TypeError(
      'Ground-cover receiveShadow must be true, false, or "auto".',
    );
  }
  return {
    castShadow: Boolean(castShadow),
    receiveShadow: receiveShadow === 'auto'
      ? !terrainReceivesShadow
      : receiveShadow,
    mode: receiveShadow === 'auto'
      ? terrainReceivesShadow
        ? 'terrain-projected'
        : 'mesh-received'
      : receiveShadow
        ? 'mesh-received'
        : 'unshadowed',
  };
}

export function applyGroundCoverShadowPolicy(mesh, options) {
  if (!mesh) {
    throw new TypeError('Ground-cover shadow policy requires a mesh.');
  }
  const policy = resolveGroundCoverShadowPolicy(options);
  mesh.castShadow = policy.castShadow;
  mesh.receiveShadow = policy.receiveShadow;
  mesh.userData ??= {};
  mesh.userData.groundCoverShadowPolicy = policy.mode;
  return policy;
}

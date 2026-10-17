/**
 * The engine's own switches for the calls it makes to third parties by
 * itself. Without them OpenCode 2 downloads the public model catalog from
 * models.opencode.ai when it starts and checks for its own updates, even
 * while the provider lock allows only Mittr. Mittr's models come from the
 * Mittr catalog and the app ships the engine it runs, so neither call is
 * needed, and company metadata stays inside. The engine then uses the catalog
 * it bundles for the providers the lock may later show.
 */
export const ENGINE_OUTBOUND_OFF = Object.freeze({
  OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1',
});

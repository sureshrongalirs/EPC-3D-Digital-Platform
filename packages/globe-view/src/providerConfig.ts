import * as Cesium from 'cesium';

/**
 * Injectable override point for terrain/imagery (CLAUDE.md's "Rendering surfaces" note).
 * Leaving all three fields unset defaults to Cesium Ion's hosted World Terrain + Bing
 * Aerial imagery, using whichever access token the `cesium` npm package ships with by
 * default if `ionAccessToken` isn't given either (see createTerrainAndImageryProviders'
 * doc comment for what that means in practice, and CLAUDE.md invariant #7's tension with
 * this default).
 *
 * Providing `terrainProviderUrl`/`imageryProviderUrl` (e.g. pointing at a self-hosted
 * `cesium-terrain-builder` output or an internal WMTS/XYZ tile server) is the swap point
 * for a real on-premise/air-gapped deployment -- this interface exists specifically so
 * that swap never requires touching this package's own code, only the config passed to
 * `GlobeView`'s constructor.
 *
 * Google 3D Tiles (photorealistic global imagery) is also a supported swap: set
 * `imageryProviderUrl` to the Google Map Tiles API root URL and supply your Google Cloud
 * API key as a query parameter per Google's documentation -- no code change needed, purely
 * a config value at `GlobeView` construction time.
 */
export interface GlobeProviderConfig {
  terrainProviderUrl?: string;
  imageryProviderUrl?: string;
  ionAccessToken?: string;
}

export interface ResolvedGlobeProviderConfig {
  /** True when neither terrainProviderUrl nor imageryProviderUrl was overridden -- i.e.
   * this will use Cesium Ion's hosted assets. */
  usesIonDefaults: boolean;
  terrainProviderUrl: string | undefined;
  imageryProviderUrl: string | undefined;
  ionAccessToken: string | undefined;
}

/**
 * Pure config-merging step, deliberately kept separate from
 * createTerrainAndImageryProviders (which calls live Cesium/Ion APIs and can't be
 * meaningfully unit-tested without real network access or heavy mocking) -- this function
 * only decides *what* to use, never *fetches* anything, so it's fully unit-testable.
 */
export function resolveProviderConfig(overrides: GlobeProviderConfig = {}): ResolvedGlobeProviderConfig {
  return {
    usesIonDefaults: overrides.terrainProviderUrl === undefined && overrides.imageryProviderUrl === undefined,
    terrainProviderUrl: overrides.terrainProviderUrl,
    imageryProviderUrl: overrides.imageryProviderUrl,
    ionAccessToken: overrides.ionAccessToken,
  };
}

/**
 * Constructs the actual Cesium terrain/imagery provider instances for a resolved config.
 * Not unit-tested (see resolveProviderConfig's comment) -- exercised only by manual/E2E
 * verification against a real Cesium Viewer.
 *
 * Cesium Ion token findings (see CLAUDE.md's "Rendering surfaces" note and this task's
 * report): the `cesium` npm package ships with `Cesium.Ion.defaultAccessToken` already set
 * to a public, rate-limited demo token maintained by Cesium GS Inc., specifically so a
 * fresh install works out of the box for evaluation without requiring anyone to sign up
 * first. Per Cesium's own docs/ion.cesium.com terms, that shared demo token is intended for
 * short-term evaluation only and is explicitly *not* meant for production or sustained use
 * (it can be rate-limited or rotated without notice) -- real deployments are expected to
 * either supply their own free/paid Ion token via `ionAccessToken`, or bypass Ion entirely
 * via `terrainProviderUrl`/`imageryProviderUrl` (self-hosted tiles), which this function
 * does whenever either is provided. Failing/expired Ion auth does not crash Cesium.Viewer
 * itself -- terrain/imagery providers fail per-tile (the globe renders with missing/blank
 * tiles, not a thrown exception), which is why GlobeView still constructs and shows its
 * georef-status UI even if the base map fails to load.
 */
export async function createTerrainAndImageryProviders(
  config: ResolvedGlobeProviderConfig,
): Promise<{ terrainProvider: Cesium.TerrainProvider; imageryProvider: Cesium.ImageryProvider }> {
  if (config.ionAccessToken) {
    Cesium.Ion.defaultAccessToken = config.ionAccessToken;
  }
  // else: leave Cesium.Ion.defaultAccessToken as whatever the `cesium` package's own
  // default is -- see this function's doc comment.

  const terrainProvider = config.terrainProviderUrl
    ? await Cesium.CesiumTerrainProvider.fromUrl(config.terrainProviderUrl)
    : await Cesium.createWorldTerrainAsync();

  const imageryProvider = config.imageryProviderUrl
    ? new Cesium.UrlTemplateImageryProvider({ url: config.imageryProviderUrl })
    : await Cesium.createWorldImageryAsync();

  return { terrainProvider, imageryProvider };
}

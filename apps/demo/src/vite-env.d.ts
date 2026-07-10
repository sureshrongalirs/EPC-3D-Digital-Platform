/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Real Cesium Ion access token for the 3D globe view's terrain/imagery, overriding the
   * `cesium` package's bundled evaluation-only demo token -- see
   * @plantscope/globe-view's providerConfig.ts and CLAUDE.md's "Rendering surfaces" note.
   * Optional: unset falls back to that demo token. */
  readonly VITE_CESIUM_ION_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

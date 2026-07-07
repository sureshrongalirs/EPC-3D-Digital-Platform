// Public API surface of @plantscope/plugins. Hard rule for this package (see CLAUDE.md and
// internal/isolation.test.ts, which greps the built output): nothing here may import
// "three" — plugins interact with the viewer only through the PluginContext facade
// exported by @plantscope/core.
export { createMockRestClient } from './mock/mockRestClient';
export type { MockRestClient, MockRestClientOptions } from './mock/mockRestClient';

export { createZonesPlugin, ZonesPlugin } from './zones/ZonesPlugin';
export type { ZonesPluginApi } from './zones/ZonesPlugin';
export { selectObjectsInRect } from './zones/boxSelect';
export type { ScreenRect } from './zones/boxSelect';
export { computeZoneBoundary } from './zones/zoneBoundary';
export type { ZoneBoundary } from './zones/zoneBoundary';

export { createMapGeorefPlugin, MapGeorefPlugin } from './mapGeoref/MapGeorefPlugin';

export { createLinkageMetadataPlugin, LinkageMetadataPlugin } from './linkage/LinkageMetadataPlugin';
export { resolveLinkage } from './linkage/resolveLinkage';
export type { LabelIndexEntry, LinkageLookupOptions, LinkageLookupResult } from './linkage/resolveLinkage';

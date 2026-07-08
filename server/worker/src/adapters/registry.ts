import type { SourceFileRef } from '@plantscope/server-shared';

import { fbxAdapter } from './fbx/index.js';
import { glbAdapter } from './glb.js';
import { llhAdapter } from './llh/index.js';
import { mdb2Adapter } from './mdb2/index.js';
import { ifcAdapter, rvmAdapter } from './stubs.js';
import type { FormatAdapter } from './types.js';

/** Keyed by the upload-time SourceFileRef.kind tag (server/api/src/routes/models.ts's
 * fileKindFor) -- the primary routing path. sniff()/probe() on each adapter remain available
 * for a content-based fallback, but kind-based routing is what auto-pairing (pipeline.ts)
 * actually uses since it's already resolved once, at upload time. */
export const adaptersByKind: Record<SourceFileRef['kind'], FormatAdapter | null> = {
  fbx: fbxAdapter,
  mdb2: mdb2Adapter,
  llh: llhAdapter,
  other: null,
};

/** Registered so a future .ifc/.rvm upload fails the job loudly and specifically ("not yet
 * implemented") instead of falling through 'other' -> null -> a generic/confusing error. */
export const extensionStubAdapters: FormatAdapter[] = [ifcAdapter, rvmAdapter];

export { fbxAdapter, glbAdapter, ifcAdapter, llhAdapter, mdb2Adapter, rvmAdapter };
export * from './types.js';

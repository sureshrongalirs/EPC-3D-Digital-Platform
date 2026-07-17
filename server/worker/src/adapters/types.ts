import type { Database, SourceFileRef, TilesSummary } from '@plantscope/server-shared';

export interface ProbeReport {
  /** Rough peak-memory estimate for this job, used by the queue to decide whether it must
   * claim the queue exclusively (see config.ts's WORKER_LARGE_JOB_MB). */
  estimatedPeakMemoryMB: number;
  /** Rough output-artifact size estimate, used for the GLB-vs-3D-Tiles size routing
   * decision (CLAUDE.md invariant #4). */
  estimatedSizeMB: number;
  warnings: string[];
}

export interface ConvertContext {
  db: Database;
  modelId: string;
  siteId: string | null;
  revision: number;
  /** Absolute path to this job's source files (already resolved from DATA_DIR + the
   * model's stored SourceFileRef.path entries). */
  sourceFiles: (SourceFileRef & { absolutePath: string })[];
  /** Absolute directory this job should write artifacts into:
   * DATA_DIR/models/artifacts/{modelId}/{revision}/ (see config.ts's modelsArtifactsDir). */
  outDir: string;
  dataDir: string;
  /** See config.ts's Config.dracoForCesium doc comment -- the fbx adapter reads this to
   * decide whether to Draco-compress its GLB output. */
  dracoForCesium: boolean;
  /** CLAUDE.md invariant #4's size routing threshold, in MB: a source at or under this goes
   * to a single GLB, larger goes to the OGC 3D Tiles path (see fbx/index.ts's convert()). */
  sizeThresholdMb: number;
  /** See config.ts's Config.splitterTriangleFloor doc comment -- threaded down to
   * tiles/splitter.ts via tileGlb(). */
  splitterTriangleFloor: number;
  /** See config.ts's Config.splitterBlobWarnRatio doc comment -- threaded down to
   * tiles/splitter.ts via tileGlb(). */
  splitterBlobWarnRatio: number;
}

export interface ConvertResult {
  /** Absent for adapters that don't publish a renderable artifact themselves (e.g. LLH,
   * which only writes a georef row) -- the pipeline skips publishRevision() for those. */
  artifact?: {
    artifactType: 'glb' | 'tiles';
    /** Path relative to DATA_DIR, suitable for storage in revisions.artifact_path. */
    artifactPath: string;
    /** Task 3 deliverable 4 -- only set for artifactType 'tiles' (see tiles/index.ts's
     * tileGlb()). */
    tilesSummary?: TilesSummary;
  };
  linkageMap?: Map<string, string>;
  warnings: string[];
}

export interface FormatAdapter {
  id: string;
  /** Cheap content sniff (magic bytes / structure), independent of the upload-time
   * extension-based SourceFileRef.kind tag -- used as a fallback for 'other'-kind files. */
  sniff(absolutePath: string): Promise<boolean>;
  probe(absolutePath: string): Promise<ProbeReport>;
  convert(ctx: ConvertContext, sourceFile: SourceFileRef & { absolutePath: string }): Promise<ConvertResult>;
}

export class NotImplementedFormatError extends Error {
  constructor(formatId: string) {
    super(`format adapter '${formatId}' is not yet implemented`);
    this.name = 'NotImplementedFormatError';
  }
}

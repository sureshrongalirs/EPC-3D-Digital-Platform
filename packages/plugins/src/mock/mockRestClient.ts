import type { RestClient } from '@plantscope/core';
import type { ComponentRecord, GeorefRecord, Zone } from '@plantscope/shared';

/**
 * In-memory stand-in for server/api (Phase 3 ships a real one at these same routes).
 * Implements the same `RestClient` interface plugins get via `PluginContext.rest`, so
 * plugin code never knows the difference. Route conventions here match server/api's
 * actual endpoints (POST /api/models/{id}/georef, PATCH /api/sites/{id}, etc.) — this is
 * a standalone testing fixture now that apps/demo talks to the real API directly.
 */
export interface MockSite {
  id: string;
  name: string;
  rotationDeg: number | null;
}

export interface MockRestClientOptions {
  zones?: Zone[];
  georefRecords?: GeorefRecord[];
  components?: ComponentRecord[];
  sites?: MockSite[];
}

export interface MockRestClient extends RestClient {
  /** Test/demo convenience — inspect the in-memory store without going through `get`. */
  snapshotZones(): Zone[];
}

const ZONES_PATH = '/api/zones';
const ZONE_DELETE_RE = /^\/api\/zones\/([^/]+)\/delete$/;
const GEOREF_GET_RE = /^\/api\/models\/([^/]+)\/georef$/;
const GEOREF_RESET_RE = /^\/api\/models\/([^/]+)\/georef\/reset$/;
const COMPONENT_GET_RE = /^\/api\/components\/([^/]+)(?:\?.*)?$/;
const SITE_PATCH_RE = /^\/api\/sites\/([^/]+)$/;
const SITES_PATH = '/api/sites';

export function createMockRestClient(options: MockRestClientOptions = {}): MockRestClient {
  const zones = new Map<string, Zone>((options.zones ?? []).map((z) => [z.id, z]));
  const georefByModelId = new Map<string, GeorefRecord>(
    (options.georefRecords ?? []).map((g) => [g.modelId, g]),
  );
  const components = new Map<string, ComponentRecord>(
    (options.components ?? []).map((c) => [c.linkageKey, c]),
  );
  const sites = new Map<string, MockSite>((options.sites ?? []).map((s) => [s.id, s]));
  let nextZoneId = 1;
  let nextSiteId = 1;

  function resolveRotation(siteId: string | null | undefined, explicitRotationDeg: number | null | undefined) {
    if (explicitRotationDeg !== null && explicitRotationDeg !== undefined) {
      return { rotationDeg: explicitRotationDeg, rotationSource: 'model_override' as const };
    }
    const site = siteId ? sites.get(siteId) : undefined;
    if (site?.rotationDeg !== null && site?.rotationDeg !== undefined) {
      return { rotationDeg: site.rotationDeg, rotationSource: 'site_inherited' as const };
    }
    return { rotationDeg: 0, rotationSource: 'default' as const };
  }

  async function get<T>(path: string): Promise<T> {
    if (path.startsWith(ZONES_PATH)) {
      return [...zones.values()] as T;
    }

    const georefMatch = GEOREF_GET_RE.exec(path);
    if (georefMatch?.[1]) {
      const record = georefByModelId.get(georefMatch[1]);
      if (!record) throw new Error(`No georef record for model "${georefMatch[1]}"`);
      return record as T;
    }

    const componentMatch = COMPONENT_GET_RE.exec(path);
    if (componentMatch?.[1]) {
      const record = components.get(componentMatch[1]);
      if (!record) throw new Error(`No component for linkage key "${componentMatch[1]}"`);
      return record as T;
    }

    throw new Error(`MockRestClient: no GET handler for "${path}"`);
  }

  async function post<T>(path: string, body?: unknown): Promise<T> {
    if (path === ZONES_PATH) {
      const zone = body as Zone;
      const id = zone.id || `zone-${nextZoneId++}`;
      const stored: Zone = { ...zone, id };
      zones.set(id, stored);
      return stored as T;
    }

    const deleteMatch = ZONE_DELETE_RE.exec(path);
    if (deleteMatch?.[1]) {
      zones.delete(deleteMatch[1]);
      return { ok: true } as T;
    }

    if (path === SITES_PATH) {
      const input = body as { name: string; rotationDeg?: number | null };
      const id = `site-${nextSiteId++}`;
      const site: MockSite = { id, name: input.name, rotationDeg: input.rotationDeg ?? null };
      sites.set(id, site);
      return site as T;
    }

    const georefMatch = GEOREF_GET_RE.exec(path);
    if (georefMatch?.[1]) {
      const modelId = georefMatch[1];
      const input = body as Partial<GeorefRecord>;
      const existing = georefByModelId.get(modelId);
      const { rotationDeg, rotationSource } = resolveRotation(existing?.siteId, input.rotationDeg ?? null);
      const record: GeorefRecord = {
        modelId,
        siteId: existing?.siteId ?? null,
        anchorLat: input.anchorLat ?? existing?.anchorLat ?? 0,
        anchorLon: input.anchorLon ?? existing?.anchorLon ?? 0,
        height: input.height ?? existing?.height ?? null,
        heightDatum: input.heightDatum ?? existing?.heightDatum ?? 'unknown',
        rotationDeg,
        rotationSource,
        method: input.method ?? existing?.method ?? 'provided',
        anchorConvention: input.anchorConvention ?? existing?.anchorConvention ?? 'model_origin',
      };
      georefByModelId.set(modelId, record);
      return record as T;
    }

    const resetMatch = GEOREF_RESET_RE.exec(path);
    if (resetMatch?.[1]) {
      const existing = georefByModelId.get(resetMatch[1]);
      if (!existing) throw new Error(`No georef record for model "${resetMatch[1]}"`);
      const { rotationDeg, rotationSource } = resolveRotation(existing.siteId, null);
      const record: GeorefRecord = { ...existing, rotationDeg, rotationSource };
      georefByModelId.set(resetMatch[1], record);
      return record as T;
    }

    throw new Error(`MockRestClient: no POST handler for "${path}"`);
  }

  async function patch<T>(path: string, body?: unknown): Promise<T> {
    const siteMatch = SITE_PATCH_RE.exec(path);
    if (siteMatch?.[1]) {
      const site = sites.get(siteMatch[1]);
      if (!site) throw new Error(`No site "${siteMatch[1]}"`);
      const { rotationDeg } = body as { rotationDeg: number };
      site.rotationDeg = rotationDeg;

      let affectedModelsCount = 0;
      for (const [modelId, record] of georefByModelId) {
        if (record.siteId === site.id && record.rotationSource !== 'model_override') {
          georefByModelId.set(modelId, { ...record, rotationDeg, rotationSource: 'site_inherited' });
          affectedModelsCount += 1;
        }
      }
      return { site, affectedModelsCount } as T;
    }

    throw new Error(`MockRestClient: no PATCH handler for "${path}"`);
  }

  return { get, post, patch, snapshotZones: () => [...zones.values()] };
}

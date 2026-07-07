import type { RestClient } from '@plantscope/core';
import type { ComponentRecord, GeorefRecord, Zone } from '@plantscope/shared';

/**
 * In-memory stand-in for the real API server (arrives in Phase 3). Implements the same
 * `RestClient` interface plugins get via `PluginContext.rest`, so plugin code never knows
 * the difference — see CLAUDE.md's Phase status and the ZonesPlugin/MapGeorefPlugin/
 * LinkageMetadataPlugin persistence sections.
 */
export interface MockRestClientOptions {
  zones?: Zone[];
  georefRecords?: GeorefRecord[];
  components?: ComponentRecord[];
}

export interface MockRestClient extends RestClient {
  /** Demo/test convenience — inspect the in-memory store without going through `get`. */
  snapshotZones(): Zone[];
}

const ZONES_PATH = '/api/zones';
const ZONE_DELETE_RE = /^\/api\/zones\/([^/]+)\/delete$/;
const GEOREF_PATH = '/api/georef';
const GEOREF_GET_RE = /^\/api\/georef\/([^/]+)$/;
const COMPONENT_GET_RE = /^\/api\/components\/([^/]+)$/;

export function createMockRestClient(options: MockRestClientOptions = {}): MockRestClient {
  const zones = new Map<string, Zone>((options.zones ?? []).map((z) => [z.id, z]));
  const georefByModelId = new Map<string, GeorefRecord>(
    (options.georefRecords ?? []).map((g) => [g.modelId, g]),
  );
  const components = new Map<string, ComponentRecord>(
    (options.components ?? []).map((c) => [c.linkageKey, c]),
  );
  let nextZoneId = 1;

  async function get<T>(path: string): Promise<T> {
    if (path === ZONES_PATH) {
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

    if (path === GEOREF_PATH) {
      const record = body as GeorefRecord;
      georefByModelId.set(record.modelId, record);
      return record as T;
    }

    throw new Error(`MockRestClient: no POST handler for "${path}"`);
  }

  return { get, post, snapshotZones: () => [...zones.values()] };
}

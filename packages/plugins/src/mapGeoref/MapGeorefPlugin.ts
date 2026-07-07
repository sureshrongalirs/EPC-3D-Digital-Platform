import type { PlantScopePlugin, PluginContext } from '@plantscope/core';
import {
  computeConvexHull2D,
  localToLatLon,
  type AnchorConvention,
  type GeorefMethod,
  type GeorefRecord,
  type HeightDatum,
  type LatLon,
  type ModelInfo,
  type Point2D,
  type RotationSource,
} from '@plantscope/shared';
import * as L from 'leaflet';

// Real client anchor coordinates are never hardcoded here — this is an explicitly-labeled
// placeholder for the demo only, per the task brief. Real anchors come from an LLH upload
// or the interactive map (see CLAUDE.md's Georeferencing invariants).
const DEFAULT_ANCHOR: LatLon = { lat: 29.4749, lon: 76.8909 };
const DEFAULT_LABEL = 'test default — not surveyed';

// Vendored the same way as packages/core's DRACO decoder assets — the host app serves
// leaflet's own dist/leaflet.css locally so this plugin never depends on a CSS CDN.
// apps/demo does so from public/vendor/leaflet/leaflet.css.
const LEAFLET_CSS_HREF = '/vendor/leaflet/leaflet.css';

interface AnchorState {
  lat: number;
  lon: number;
  rotationDeg: number;
  height?: number;
  heightDatum: HeightDatum;
  method: GeorefMethod;
  rotationSource: RotationSource;
  anchorConvention: AnchorConvention;
}

function defaultAnchorState(): AnchorState {
  return {
    lat: DEFAULT_ANCHOR.lat,
    lon: DEFAULT_ANCHOR.lon,
    rotationDeg: 0,
    heightDatum: 'unknown',
    method: 'assumed',
    rotationSource: 'default',
    anchorConvention: 'model-origin',
  };
}

function ensureLeafletCss(): void {
  if (document.querySelector(`link[href="${LEAFLET_CSS_HREF}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = LEAFLET_CSS_HREF;
  document.head.appendChild(link);
}

export class MapGeorefPlugin implements PlantScopePlugin {
  readonly id = 'plantscope.map-georef';
  readonly version = '0.1.0';

  private ctx: PluginContext | null = null;
  private currentModel: ModelInfo | null = null;
  private anchor: AnchorState = defaultAnchorState();
  private modelFootprint: Point2D[] = [];

  private map: L.Map | null = null;
  private footprintLayer: L.Polygon | null = null;
  private anchorMarker: L.CircleMarker | null = null;
  private badgeEl: HTMLElement | null = null;
  private rotationInput: HTMLInputElement | null = null;

  readonly contributes: PlantScopePlugin['contributes'] = {
    panels: [
      {
        id: 'plantscope.map-georef.panel',
        title: 'Map / Georeference',
        render: (container) => this.renderPanel(container),
      },
    ],
  };

  readonly hooks: PlantScopePlugin['hooks'] = {
    onModelLoaded: (model) => {
      this.currentModel = model;
      void this.handleModelLoaded(model);
    },
  };

  onInstall(): void {
    // No setup needed against the raw Viewer beyond what onActivate's ctx provides.
  }

  onActivate(ctx: PluginContext): void {
    this.ctx = ctx;
    ensureLeafletCss();
  }

  onDeactivate(): void {
    this.map?.remove();
    this.map = null;
    this.ctx = null;
  }

  private async handleModelLoaded(model: ModelInfo): Promise<void> {
    if (!this.ctx) return;
    this.modelFootprint = this.computeModelFootprint();

    try {
      // Load an existing placement rather than forcing click-to-anchor from scratch.
      const record = await this.ctx.rest.get<GeorefRecord>(`/api/georef/${model.id}`);
      this.anchor = {
        lat: record.anchorLat,
        lon: record.anchorLon,
        rotationDeg: record.rotationDeg,
        height: record.height,
        heightDatum: record.heightDatum,
        method: record.method,
        rotationSource: record.rotationSource,
        anchorConvention: record.anchorConvention,
      };
    } catch {
      this.anchor = defaultAnchorState();
    }

    this.refreshMap();
  }

  /** Convex hull over every object's world bbox X/Z corners — the whole model's footprint. */
  private computeModelFootprint(): Point2D[] {
    if (!this.ctx) return [];
    const objects = this.ctx.viewer.searchObjects(''); // empty substring matches every object
    const corners: Point2D[] = [];
    for (const { id } of objects) {
      const bounds = this.ctx.viewer.getObjectBounds(id);
      if (!bounds) continue;
      const { min, max } = bounds.bbox;
      corners.push(
        { x: min.x, y: min.z },
        { x: min.x, y: max.z },
        { x: max.x, y: min.z },
        { x: max.x, y: max.z },
      );
    }
    return computeConvexHull2D(corners);
  }

  private renderPanel(container: HTMLElement): void {
    this.badgeEl = document.createElement('div');

    const searchForm = document.createElement('form');
    const searchInput = document.createElement('input');
    searchInput.placeholder = 'Search a place (Nominatim)';
    const searchResults = document.createElement('ul');
    searchForm.append(searchInput, searchResults);
    searchForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.searchPlaces(searchInput.value, searchResults);
    });

    const mapEl = document.createElement('div');
    Object.assign(mapEl.style, { width: '100%', height: '260px' });

    const rotationLabel = document.createElement('label');
    rotationLabel.textContent = 'Rotation (deg clockwise from north): ';
    this.rotationInput = document.createElement('input');
    this.rotationInput.type = 'range';
    this.rotationInput.min = '-180';
    this.rotationInput.max = '180';
    this.rotationInput.step = '1';
    this.rotationInput.value = String(this.anchor.rotationDeg);
    this.rotationInput.addEventListener('input', () => {
      this.anchor.rotationDeg = Number(this.rotationInput?.value ?? 0);
      this.redrawFootprint();
    });
    this.rotationInput.addEventListener('change', () => {
      this.anchor.rotationSource = 'model_override';
      this.updateBadge();
    });
    rotationLabel.appendChild(this.rotationInput);

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.textContent = 'Save georeference';
    saveButton.addEventListener('click', () => void this.save());

    container.append(this.badgeEl, searchForm, mapEl, rotationLabel, saveButton);

    const map = L.map(mapEl).setView([this.anchor.lat, this.anchor.lon], 17);
    this.map = map;
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    map.on('click', (event: L.LeafletMouseEvent) => {
      this.anchor.lat = event.latlng.lat;
      this.anchor.lon = event.latlng.lng;
      this.anchor.method = 'provided';
      this.updateBadge();
      this.redrawFootprint();
    });

    this.updateBadge();
    this.redrawFootprint();
  }

  private async searchPlaces(query: string, resultsEl: HTMLElement): Promise<void> {
    resultsEl.replaceChildren();
    if (!query.trim()) return;

    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`,
      );
      const results = (await res.json()) as { display_name: string; lat: string; lon: string }[];
      for (const result of results) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = result.display_name;
        button.addEventListener('click', () => {
          this.anchor.lat = Number(result.lat);
          this.anchor.lon = Number(result.lon);
          this.anchor.method = 'provided';
          this.map?.setView([this.anchor.lat, this.anchor.lon], 17);
          this.updateBadge();
          this.redrawFootprint();
        });
        li.appendChild(button);
        resultsEl.appendChild(li);
      }
    } catch {
      const li = document.createElement('li');
      li.textContent = 'Place search failed (offline, or Nominatim unreachable).';
      resultsEl.appendChild(li);
    }
  }

  private refreshMap(): void {
    if (!this.map) return;
    this.map.setView([this.anchor.lat, this.anchor.lon], this.map.getZoom());
    if (this.rotationInput) this.rotationInput.value = String(this.anchor.rotationDeg);
    this.updateBadge();
    this.redrawFootprint();
  }

  private redrawFootprint(): void {
    if (!this.map) return;

    const latLngs = this.modelFootprint.map((point) =>
      localToLatLon(point, { lat: this.anchor.lat, lon: this.anchor.lon }, this.anchor.rotationDeg),
    );

    this.footprintLayer?.remove();
    this.footprintLayer =
      latLngs.length >= 3
        ? L.polygon(
            latLngs.map((ll): [number, number] => [ll.lat, ll.lon]),
            { color: '#2a7fff' },
          ).addTo(this.map)
        : null;

    this.anchorMarker?.remove();
    this.anchorMarker = L.circleMarker([this.anchor.lat, this.anchor.lon], {
      radius: 6,
      color: '#ff2a2a',
    }).addTo(this.map);
  }

  private updateBadge(): void {
    if (!this.badgeEl) return;
    const isUnrefinedDefault = this.anchor.method === 'assumed' && this.anchor.rotationSource === 'default';
    const provenance = `method: ${this.anchor.method}, rotation: ${this.anchor.rotationSource}`;
    this.badgeEl.textContent = isUnrefinedDefault ? `${DEFAULT_LABEL} (${provenance})` : provenance;
  }

  private async save(): Promise<void> {
    if (!this.ctx || !this.currentModel) return;
    const record: GeorefRecord = {
      modelId: this.currentModel.id,
      anchorLat: this.anchor.lat,
      anchorLon: this.anchor.lon,
      height: this.anchor.height,
      heightDatum: this.anchor.heightDatum,
      rotationDeg: this.anchor.rotationDeg,
      rotationSource: this.anchor.rotationSource,
      method: this.anchor.method,
      anchorConvention: this.anchor.anchorConvention,
    };
    await this.ctx.rest.post('/api/georef', record);
  }
}

export function createMapGeorefPlugin(): MapGeorefPlugin {
  return new MapGeorefPlugin();
}

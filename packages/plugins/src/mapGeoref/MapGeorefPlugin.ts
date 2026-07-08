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
  height: number | null;
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
    height: null,
    heightDatum: 'unknown',
    method: 'assumed',
    rotationSource: 'default',
    anchorConvention: 'model_origin',
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
  private currentSiteId: string | null = null;
  private anchor: AnchorState = defaultAnchorState();
  private modelFootprint: Point2D[] = [];

  private map: L.Map | null = null;
  private footprintLayer: L.Polygon | null = null;
  private anchorMarker: L.CircleMarker | null = null;
  private badgeEl: HTMLElement | null = null;
  private rotationInput: HTMLInputElement | null = null;
  private saveAsSiteDefaultButton: HTMLButtonElement | null = null;
  private resetToSiteDefaultButton: HTMLButtonElement | null = null;

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

    // ModelInfo (the facade's load result) doesn't carry site_id — fetch the catalog
    // entry for it. Needed to gate "Save as site default" and resolve inheritance.
    try {
      const modelDto = await this.ctx.rest.get<{ siteId: string | null }>(`/api/models/${model.id}`);
      this.currentSiteId = modelDto.siteId;
    } catch {
      this.currentSiteId = null;
    }

    try {
      // Load an existing placement rather than forcing click-to-anchor from scratch.
      const record = await this.ctx.rest.get<GeorefRecord>(`/api/models/${model.id}/georef`);
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

    this.saveAsSiteDefaultButton = document.createElement('button');
    this.saveAsSiteDefaultButton.type = 'button';
    this.saveAsSiteDefaultButton.textContent = 'Save as site default';
    this.saveAsSiteDefaultButton.addEventListener('click', () => void this.saveAsSiteDefault());

    this.resetToSiteDefaultButton = document.createElement('button');
    this.resetToSiteDefaultButton.type = 'button';
    this.resetToSiteDefaultButton.textContent = 'Reset to site default';
    this.resetToSiteDefaultButton.addEventListener('click', () => void this.resetToSiteDefault());

    container.append(
      this.badgeEl,
      searchForm,
      mapEl,
      rotationLabel,
      saveButton,
      this.saveAsSiteDefaultButton,
      this.resetToSiteDefaultButton,
    );

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

  private rotationSourceLabel(): string {
    switch (this.anchor.rotationSource) {
      case 'model_override':
        return 'Custom for this model';
      case 'site_inherited':
        return 'Site default';
      case 'default':
        return 'Not set';
    }
  }

  private updateBadge(): void {
    if (!this.badgeEl) return;
    const isUnrefinedDefault = this.anchor.method === 'assumed' && this.anchor.rotationSource === 'default';
    const label = `${this.rotationSourceLabel()} (method: ${this.anchor.method})`;
    this.badgeEl.textContent = isUnrefinedDefault ? `${DEFAULT_LABEL} — ${label}` : label;

    // "Save as site default" only makes sense for a model that belongs to a site.
    if (this.saveAsSiteDefaultButton) this.saveAsSiteDefaultButton.hidden = !this.currentSiteId;
    // "Reset to site default" only makes sense once there's an override to clear.
    if (this.resetToSiteDefaultButton) {
      this.resetToSiteDefaultButton.hidden = this.anchor.rotationSource !== 'model_override';
    }
  }

  private buildGeorefRecord(): GeorefRecord {
    if (!this.currentModel) throw new Error('no model loaded');
    return {
      modelId: this.currentModel.id,
      siteId: this.currentSiteId,
      anchorLat: this.anchor.lat,
      anchorLon: this.anchor.lon,
      height: this.anchor.height,
      heightDatum: this.anchor.heightDatum,
      rotationDeg: this.anchor.rotationDeg,
      rotationSource: this.anchor.rotationSource,
      method: this.anchor.method,
      anchorConvention: this.anchor.anchorConvention,
    };
  }

  private async save(): Promise<void> {
    if (!this.ctx || !this.currentModel) return;
    const saved = await this.ctx.rest.post<GeorefRecord>(
      `/api/models/${this.currentModel.id}/georef`,
      this.buildGeorefRecord(),
    );
    this.anchor.rotationDeg = saved.rotationDeg;
    this.anchor.rotationSource = saved.rotationSource;
    this.refreshMap();
  }

  /**
   * "Save as site default" (CLAUDE.md: propagation is only ever this one explicit
   * action). Confirms with the user first — the PATCH itself is what tells us how many
   * other models are affected, so that count is reported back as confirmation the write
   * happened, not as a preview before it.
   */
  private async saveAsSiteDefault(): Promise<void> {
    if (!this.ctx || !this.currentSiteId) return;
    const confirmed = window.confirm(
      `Save ${this.anchor.rotationDeg.toFixed(1)}° as this site's default rotation? ` +
        'Other models at this site that are not individually overridden will switch to this value.',
    );
    if (!confirmed) return;

    const result = await this.ctx.rest.patch<{ affectedModelsCount: number }>(`/api/sites/${this.currentSiteId}`, {
      rotationDeg: this.anchor.rotationDeg,
    });
    window.alert(`Saved. ${result.affectedModelsCount} other model(s) now inherit this rotation.`);

    if (this.currentModel) await this.handleModelLoaded(this.currentModel);
  }

  private async resetToSiteDefault(): Promise<void> {
    if (!this.ctx || !this.currentModel) return;
    const record = await this.ctx.rest.post<GeorefRecord>(`/api/models/${this.currentModel.id}/georef/reset`);
    this.anchor.rotationDeg = record.rotationDeg;
    this.anchor.rotationSource = record.rotationSource;
    this.refreshMap();
  }
}

export function createMapGeorefPlugin(): MapGeorefPlugin {
  return new MapGeorefPlugin();
}

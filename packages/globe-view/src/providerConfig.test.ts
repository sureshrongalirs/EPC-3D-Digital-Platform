import { describe, expect, it } from 'vitest';

import { resolveProviderConfig } from './providerConfig.js';

describe('resolveProviderConfig', () => {
  it('uses Ion defaults when no override is given', () => {
    const resolved = resolveProviderConfig();
    expect(resolved).toEqual({
      usesIonDefaults: true,
      terrainProviderUrl: undefined,
      imageryProviderUrl: undefined,
      ionAccessToken: undefined,
    });
  });

  it('uses Ion defaults when called with an explicit empty object', () => {
    const resolved = resolveProviderConfig({});
    expect(resolved.usesIonDefaults).toBe(true);
  });

  it('passes through a terrainProviderUrl override and marks usesIonDefaults false', () => {
    const resolved = resolveProviderConfig({ terrainProviderUrl: 'https://terrain.internal/tiles' });
    expect(resolved.usesIonDefaults).toBe(false);
    expect(resolved.terrainProviderUrl).toBe('https://terrain.internal/tiles');
    expect(resolved.imageryProviderUrl).toBeUndefined();
  });

  it('passes through an imageryProviderUrl override and marks usesIonDefaults false', () => {
    const resolved = resolveProviderConfig({ imageryProviderUrl: 'https://imagery.internal/{z}/{x}/{y}.png' });
    expect(resolved.usesIonDefaults).toBe(false);
    expect(resolved.imageryProviderUrl).toBe('https://imagery.internal/{z}/{x}/{y}.png');
  });

  it('passes through an ionAccessToken override without affecting usesIonDefaults on its own', () => {
    // A custom Ion token alone still means "use Ion" -- just not the shared demo token --
    // so usesIonDefaults (which only tracks terrain/imagery *provider* overrides) stays true.
    const resolved = resolveProviderConfig({ ionAccessToken: 'my-real-ion-token' });
    expect(resolved.usesIonDefaults).toBe(true);
    expect(resolved.ionAccessToken).toBe('my-real-ion-token');
  });

  it('passes through all three overrides together, unmodified', () => {
    const overrides = {
      terrainProviderUrl: 'https://terrain.internal/tiles',
      imageryProviderUrl: 'https://imagery.internal/{z}/{x}/{y}.png',
      ionAccessToken: 'unused-since-ion-is-bypassed',
    };
    const resolved = resolveProviderConfig(overrides);
    expect(resolved).toEqual({ usesIonDefaults: false, ...overrides });
  });
});

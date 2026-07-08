import { describe, expect, it } from 'vitest';

import { parseLLH } from './parse.js';

describe('parseLLH', () => {
  it('parses the line format with a Rotation line', () => {
    const text = 'Latitude: 40.7128\nLongitude: -74.0060\nHeight: 12.5\nRotation: 15.5\n';
    expect(parseLLH(text)).toEqual({ latitude: 40.7128, longitude: -74.006, height: 12.5, rotationDeg: 15.5 });
  });

  it('parses the line format without a Rotation line (rotationDeg is undefined)', () => {
    const text = 'latitude:51.5\nlongitude:-0.1\n';
    const result = parseLLH(text);
    expect(result.rotationDeg).toBeUndefined();
    expect(result.latitude).toBe(51.5);
    expect(result.longitude).toBe(-0.1);
    expect(result.height).toBeNull();
  });

  it('tolerates case and surrounding whitespace', () => {
    const text = '  LATITUDE :  10  \n  LONGITUDE:  20  \n';
    expect(parseLLH(text)).toEqual({ latitude: 10, longitude: 20, height: null, rotationDeg: undefined });
  });

  it('parses an equivalent JSON shape', () => {
    const text = JSON.stringify({ latitude: 1, longitude: 2, height: 3, rotation: 45 });
    expect(parseLLH(text)).toEqual({ latitude: 1, longitude: 2, height: 3, rotationDeg: 45 });
  });

  it('parses JSON without a rotation field', () => {
    const text = JSON.stringify({ latitude: 1, longitude: 2 });
    const result = parseLLH(text);
    expect(result.rotationDeg).toBeUndefined();
  });

  it('rejects out-of-range latitude', () => {
    expect(() => parseLLH('Latitude: 91\nLongitude: 0\n')).toThrow(/latitude/i);
  });

  it('rejects out-of-range longitude', () => {
    expect(() => parseLLH('Latitude: 0\nLongitude: 200\n')).toThrow(/longitude/i);
  });

  it('rejects malformed input missing required fields', () => {
    expect(() => parseLLH('Height: 5\n')).toThrow(/missing required/i);
  });

  it('rejects non-numeric coordinate values', () => {
    expect(() => parseLLH('Latitude: north\nLongitude: 0\n')).toThrow(/not a number/i);
  });
});

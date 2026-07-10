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

  describe('bare "Longitude Latitude Height" triplet format (the real-world LLH format)', () => {
    it('parses a single line of 3 whitespace-separated numbers as Longitude Latitude Height', () => {
      const text = '-111.73694444444445 57.32694444444445 0';
      expect(parseLLH(text)).toEqual({
        latitude: 57.32694444444445,
        longitude: -111.73694444444445,
        height: 0,
        rotationDeg: undefined,
      });
    });

    it('tolerates surrounding whitespace and trailing newlines', () => {
      const text = '  78.486671 17.385044 520.35  \n\n';
      expect(parseLLH(text)).toEqual({ latitude: 17.385044, longitude: 78.486671, height: 520.35, rotationDeg: undefined });
    });

    it('tolerates multiple/tab whitespace between the three numbers', () => {
      const text = '78.486671\t17.385044   520.35';
      expect(parseLLH(text)).toEqual({ latitude: 17.385044, longitude: 78.486671, height: 520.35, rotationDeg: undefined });
    });

    it('height of exactly 0 is preserved (not treated as null/missing)', () => {
      const result = parseLLH('10 20 0');
      expect(result.height).toBe(0);
    });

    it('rejects an out-of-range latitude in triplet form', () => {
      // lon=0, lat=91 (2nd token) -- out of [-90, 90]
      expect(() => parseLLH('0 91 0')).toThrow(/latitude/i);
    });

    it('rejects an out-of-range longitude in triplet form', () => {
      // lon=200 (1st token), lat=0 -- out of [-180, 180]
      expect(() => parseLLH('200 0 0')).toThrow(/longitude/i);
    });

    it('does not misinterpret the labeled line format as a triplet (labels contain ":")', () => {
      const text = 'Latitude: 40.7128\nLongitude: -74.0060\nHeight: 12.5\n';
      const result = parseLLH(text);
      expect(result).toEqual({ latitude: 40.7128, longitude: -74.006, height: 12.5, rotationDeg: undefined });
    });

    it('falls through to the labeled-line parser for text that is not exactly 3 numeric tokens', () => {
      // 2 lines, not a single-line triplet -- and no ":" either, so this should fail the
      // same way the pre-existing "missing required fields" case does rather than being
      // silently misparsed as a triplet.
      expect(() => parseLLH('12.5 13.5\n14.5')).toThrow(/missing required/i);
    });
  });
});

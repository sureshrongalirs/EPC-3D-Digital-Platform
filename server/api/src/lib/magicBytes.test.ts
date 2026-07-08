import { describe, expect, it } from 'vitest';

import {
  accessBuffer,
  fakeFbxTextBuffer,
  fbxBuffer,
  glbBuffer,
  llhTextBuffer,
  zipBuffer,
} from '../testUtil/fixtures.js';
import { detectFileKind, sniffAndValidate } from './magicBytes.js';

describe('detectFileKind', () => {
  it('detects zip', () => {
    expect(detectFileKind(zipBuffer())).toBe('zip');
  });
  it('detects fbx binary', () => {
    expect(detectFileKind(fbxBuffer())).toBe('fbx');
  });
  it('detects glb', () => {
    expect(detectFileKind(glbBuffer())).toBe('glb');
  });
  it('detects an Access/Jet database', () => {
    expect(detectFileKind(accessBuffer())).toBe('access');
  });
  it('detects plain text (LLH)', () => {
    expect(detectFileKind(llhTextBuffer())).toBe('llh-text');
  });
});

describe('sniffAndValidate', () => {
  it('rejects a .fbx-named file whose content is actually plain text', () => {
    const result = sniffAndValidate('model.fbx', fakeFbxTextBuffer());
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('llh-text');
  });

  it('accepts a real .fbx file', () => {
    expect(sniffAndValidate('model.fbx', fbxBuffer()).ok).toBe(true);
  });

  it('accepts a real .glb file', () => {
    expect(sniffAndValidate('model.glb', glbBuffer()).ok).toBe(true);
  });

  it('accepts a real .mdb2 file', () => {
    expect(sniffAndValidate('props.mdb2', accessBuffer()).ok).toBe(true);
  });

  it('accepts a real .llh file', () => {
    expect(sniffAndValidate('anchor.llh', llhTextBuffer()).ok).toBe(true);
  });

  it('rejects an unrecognized extension outright', () => {
    expect(sniffAndValidate('model.exe', fbxBuffer()).ok).toBe(false);
  });
});

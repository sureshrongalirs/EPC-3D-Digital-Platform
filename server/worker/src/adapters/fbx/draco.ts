import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
// draco3dgltf is CJS with no type declarations (see src/types/draco3dgltf.d.ts); Node's ESM
// interop gives us its module.exports as the default import.
import draco3d from 'draco3dgltf';

/**
 * Draco-compresses a GLB in place (reads inputPath, writes outputPath).
 *
 * Chose gltf-transform + draco3dgltf over gltfpack for this: gltfpack is a separate native
 * binary (a second Docker-image dependency, on top of assimp/mdbtools) with its own platform
 * matrix, whereas gltf-transform is a pure npm/WASM dependency already used elsewhere in this
 * monorepo (testdata/scripts/generate-two-box-gltf.mjs) for reading/writing glTF Documents --
 * one less thing for the worker's Dockerfile and CI matrix to get right, and it operates on
 * the same Document object model this repo already has some familiarity with.
 */
export async function compressWithDraco(inputPath: string, outputPath: string): Promise<void> {
  const io = new NodeIO().registerExtensions([KHRDracoMeshCompression]).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

  const doc = await io.read(inputPath);
  await doc.transform(draco());
  await io.write(outputPath, doc);
}

declare module 'draco3dgltf' {
  interface Draco3dGltfModule {
    createEncoderModule(): Promise<unknown>;
    createDecoderModule(): Promise<unknown>;
  }
  const draco3dgltf: Draco3dGltfModule;
  export default draco3dgltf;
}

// Cesium's Viewer widget needs its static Assets/ThirdParty/Widgets/Workers tree served
// from a known base URL at runtime (window.CESIUM_BASE_URL, set in src/main.ts) -- unlike
// the tiny DRACO decoder (public/draco/, ~3 files, committed directly since it barely ever
// changes), Cesium's static tree is large (fonts, textures, per-worker JS files) and fully
// reproducible from the installed `cesium` npm package, so it's copied here at dev/build
// time instead of being committed to git (same reasoning as node_modules itself: derived,
// not source). See apps/demo/.gitignore for the corresponding ignore entry.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const cesiumPackageDir = path.dirname(require.resolve('cesium/package.json'));
const source = path.join(cesiumPackageDir, 'Build', 'Cesium');
const dest = path.join(here, '..', 'public', 'cesium');

mkdirSync(dest, { recursive: true });
for (const dir of ['Assets', 'ThirdParty', 'Widgets', 'Workers']) {
  const from = path.join(source, dir);
  if (!existsSync(from)) {
    console.error(`copy-cesium-assets: expected ${from} to exist -- is the "cesium" package installed?`);
    process.exitCode = 1;
    continue;
  }
  cpSync(from, path.join(dest, dir), { recursive: true });
}
console.log(`copy-cesium-assets: copied Cesium static assets from ${source} to ${dest}`);

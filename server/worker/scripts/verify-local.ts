// Drives the worker's FBX/mdb2 adapters directly against real client sample files under
// testdata/local/ (git-ignored -- see CLAUDE.md invariant #8) WITHOUT going through the
// queue or touching Postgres. Run via scripts/verify-local.sh at the repo root, or directly:
//   pnpm --filter @plantscope/worker exec tsx scripts/verify-local.ts
//
// For every testdata/local/*.fbx: recovers the Linkages map via this repo's own
// parseFBXLinkages(), cross-checks it key-for-key against scripts/fbx_linkage_check.py's
// independent parse of the same file, and reports recovered/distinct counts. Exits non-zero
// if the two parsers disagree on even one key.
//
// For every testdata/local/*.mdb2 (or .mdb): joins linkage/labels/label_names/label_values
// via this repo's own join logic and reports the resulting object count. If a same-basename
// .fbx was also present, reports join coverage (recovered Linkage keys that have a matching
// mdb2 component) the same way pipeline.ts does for a real auto-paired job.
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseFBXLinkages } from '../src/adapters/fbx/linkage.js';
import { joinMdb2Rows, type LabelNameRow, type LabelRow, type LabelValueRow, type LinkageRow } from '../src/adapters/mdb2/join.js';
import { isMdbToolsAvailable, readMdbTableFully } from '../src/adapters/mdb2/mdbtools.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const localDir = path.join(repoRoot, 'testdata', 'local');
const groundTruthScript = path.join(repoRoot, 'scripts', 'fbx_linkage_check.py');

async function runPythonGroundTruth(fbxPath: string): Promise<Map<string, string> | null> {
  for (const pythonBin of ['python3', 'python']) {
    try {
      const { stdout } = await execFileAsync(pythonBin, [groundTruthScript, fbxPath]);
      return new Map(Object.entries(JSON.parse(stdout) as Record<string, string>));
    } catch {
      // try the next candidate binary name
    }
  }
  return null;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let mismatches = 0;
  let filesChecked = 0;

  let entries: string[];
  try {
    entries = await fsp.readdir(localDir);
  } catch {
    console.log(`no testdata/local/ directory found (${localDir}) -- nothing to verify.`);
    return;
  }

  const fbxFiles = entries.filter((f) => f.toLowerCase().endsWith('.fbx'));
  const mdb2Files = entries.filter((f) => /\.(mdb2|mdb)$/i.test(f));

  if (fbxFiles.length === 0 && mdb2Files.length === 0) {
    console.log('testdata/local/ has no .fbx or .mdb2/.mdb files -- nothing to verify.');
    return;
  }

  const fbxLinkageMapsByBasename = new Map<string, Map<string, string>>();

  for (const fbxFile of fbxFiles) {
    filesChecked += 1;
    const fbxPath = path.join(localDir, fbxFile);
    console.log(`\n=== ${fbxFile} ===`);

    const buf = await fsp.readFile(fbxPath);
    const tsMap = parseFBXLinkages(buf);
    console.log(`TS parser:     ${tsMap.size} recovered keys, ${new Set(tsMap.values()).size} distinct`);
    fbxLinkageMapsByBasename.set(path.parse(fbxFile).name, tsMap);

    const pyMap = await runPythonGroundTruth(fbxPath);
    if (!pyMap) {
      console.error('  could not run scripts/fbx_linkage_check.py (no python3/python on PATH?) -- skipping cross-check');
      continue;
    }
    console.log(`Python parser: ${pyMap.size} recovered keys`);

    let diffCount = 0;
    for (const key of new Set([...tsMap.keys(), ...pyMap.keys()])) {
      if (tsMap.get(key) !== pyMap.get(key)) {
        diffCount += 1;
        console.error(`  MISMATCH on ${JSON.stringify(key)}: ts=${JSON.stringify(tsMap.get(key))} py=${JSON.stringify(pyMap.get(key))}`);
      }
    }
    console.log(diffCount === 0 ? '  TS and Python parsers agree on every key.' : `  ${diffCount} mismatch(es) above.`);
    mismatches += diffCount;
  }

  if (mdb2Files.length > 0) {
    if (!(await isMdbToolsAvailable())) {
      console.log('\nmdbtools not installed -- skipping .mdb2 verification.');
    } else {
      for (const mdb2File of mdb2Files) {
        console.log(`\n=== ${mdb2File} ===`);
        const mdb2Path = path.join(localDir, mdb2File);
        try {
          const [linkage, labelNames, labelValues, labels] = await Promise.all([
            readMdbTableFully(mdb2Path, 'linkage'),
            readMdbTableFully(mdb2Path, 'label_names'),
            readMdbTableFully(mdb2Path, 'label_values'),
            readMdbTableFully(mdb2Path, 'labels'),
          ]);
          const joined = joinMdb2Rows({
            linkage: linkage as unknown as LinkageRow[],
            labels: labels as unknown as LabelRow[],
            labelNames: labelNames as unknown as LabelNameRow[],
            labelValues: labelValues as unknown as LabelValueRow[],
          });
          console.log(`mdb2 object count: ${joined.length}`);

          const pairedFbxMap = fbxLinkageMapsByBasename.get(path.parse(mdb2File).name);
          if (pairedFbxMap) {
            const mdb2Keys = new Set(joined.map((c) => c.linkageKey));
            const fbxKeys = [...new Set(pairedFbxMap.values())];
            const matched = fbxKeys.filter((k) => mdb2Keys.has(k)).length;
            const coverage = fbxKeys.length > 0 ? Math.round((matched / fbxKeys.length) * 100) : 100;
            console.log(`join coverage vs paired ${path.parse(mdb2File).name}.fbx: ${coverage}% (${matched}/${fbxKeys.length})`);
          }
        } catch (err) {
          console.error(`  error reading ${mdb2File}: ${String(err)}`);
        }
      }
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`\nTotal wall-clock time: ${elapsedMs}ms across ${filesChecked} FBX file(s) and ${mdb2Files.length} mdb2 file(s).`);

  if (mismatches > 0) {
    console.error(`\n${mismatches} mismatch(es) found between the TS and Python FBX parsers.`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

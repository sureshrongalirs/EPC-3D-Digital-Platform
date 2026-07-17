import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';

import type { Config } from '../config.js';
import { notFound } from '../lib/problem.js';

function resolveRequestedPath(dataDir: string, splat: string[] | string | undefined): string | null {
  const relative = Array.isArray(splat) ? splat.join('/') : String(splat ?? '');
  const resolvedRoot = path.resolve(dataDir) + path.sep;
  const resolved = path.resolve(dataDir, relative);
  if (!resolved.startsWith(resolvedRoot)) return null; // path traversal guard
  return resolved;
}

/**
 * GET /files/* — serves DATA_DIR statically with HTTP Range support (single-range only;
 * enough for a <video>/three.js-style GLB fetch, not general-purpose multi-range) and
 * Cache-Control: immutable for published, revision-numbered artifact paths (raw uploads
 * are not versioned, so they don't get the same treatment).
 */
export function createFilesRouter(config: Config): Router {
  const router = Router();

  router.get('/files/*splat', async (req, res) => {
    const resolved = resolveRequestedPath(config.dataDir, req.params['splat']);
    if (!resolved) throw notFound('file not found');

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      throw notFound('file not found');
    }
    if (!stat.isFile()) throw notFound('file not found');

    const relative = path.relative(config.dataDir, resolved).split(path.sep).join('/');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Cache-Control',
      relative.startsWith('models/artifacts/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    // Task 3 deliverable 1: revision-addressed content never changes in place (a republish
    // writes a whole new revision directory, never overwrites an existing one -- CLAUDE.md
    // invariant #6), so size+mtime is a cheap, sufficient identity for a weak ETag here; no
    // need to hash file content.
    res.setHeader('ETag', `W/"${stat.size}-${stat.mtimeMs}"`);

    const range = req.headers.range;
    if (!range) {
      res.setHeader('Content-Length', String(stat.size));
      fs.createReadStream(resolved).pipe(res);
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
      return;
    }

    let start: number;
    let end: number;
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : stat.size - 1;
    } else {
      // Suffix range: "bytes=-500" = last 500 bytes.
      const suffixLength = Number(match[2]);
      start = Math.max(stat.size - suffixLength, 0);
      end = stat.size - 1;
    }

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
      return;
    }
    end = Math.min(end, stat.size - 1);

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    fs.createReadStream(resolved, { start, end }).pipe(res);
  });

  return router;
}

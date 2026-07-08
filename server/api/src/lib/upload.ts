import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import multer from 'multer';

import { sniffAndValidate, type FileKind } from './magicBytes.js';
import { badRequest, payloadTooLarge } from './problem.js';

export function createUploadMiddleware(tempDir: string, maxUploadBytes: number): multer.Multer {
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tempDir),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}-${path.basename(file.originalname)}`),
  });
  return multer({ storage, limits: { fileSize: maxUploadBytes } });
}

/** Only reads the first few KB regardless of file size — real sources run 200MB+/800MB+. */
export async function readMagicSample(filePath: string, bytes = 4096): Promise<Buffer> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Sniffs and validates one already-saved upload, deleting it from disk if rejected. */
export async function validateUploadedFile(originalName: string, savedPath: string): Promise<FileKind> {
  const sample = await readMagicSample(savedPath);
  const { kind, ok } = sniffAndValidate(originalName, sample);
  if (!ok) {
    await fsp.rm(savedPath, { force: true });
    throw badRequest(`"${originalName}" does not look like its extension claims (sniffed as ${kind})`);
  }
  return kind;
}

export function assertWithinLimit(sizeBytes: number, maxUploadBytes: number, filename: string): void {
  if (sizeBytes > maxUploadBytes) {
    throw payloadTooLarge(`"${filename}" (${sizeBytes} bytes) exceeds the ${maxUploadBytes}-byte limit`);
  }
}

export interface UploadedFile {
  fieldname: string;
  originalname: string;
  path: string;
  size: number;
}

/**
 * Groups a batch upload's files by an explicit `groupIds` field (JSON array, positionally
 * parallel to the files) or, absent that, by identical basename (an fbx + optional mdb2 +
 * optional llh sharing a filename stem belong to one model).
 */
export function groupBatchFiles(files: UploadedFile[], groupIdsJson: string | undefined): Map<string, UploadedFile[]> {
  const explicitIds: unknown = groupIdsJson ? JSON.parse(groupIdsJson) : undefined;
  const groups = new Map<string, UploadedFile[]>();

  files.forEach((file, index) => {
    const explicit = Array.isArray(explicitIds) ? (explicitIds[index] as string | undefined) : undefined;
    const key = explicit || path.parse(file.originalname).name;
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  });

  return groups;
}

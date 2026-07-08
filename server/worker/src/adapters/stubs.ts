import path from 'node:path';

import type { FormatAdapter, ProbeReport } from './types.js';
import { NotImplementedFormatError } from './types.js';

/** Registered so an .ifc/.rvm upload gets a clear, visible "not yet implemented" job
 * failure -- rather than being silently skipped or misrouted to another adapter. */
function stubAdapter(id: string, extensions: string[]): FormatAdapter {
  return {
    id,
    async sniff(absolutePath) {
      return extensions.includes(path.extname(absolutePath).toLowerCase());
    },
    async probe(): Promise<ProbeReport> {
      return { estimatedPeakMemoryMB: 0, estimatedSizeMB: 0, warnings: [] };
    },
    async convert() {
      throw new NotImplementedFormatError(id);
    },
  };
}

export const ifcAdapter = stubAdapter('ifc', ['.ifc']);
export const rvmAdapter = stubAdapter('rvm', ['.rvm']);

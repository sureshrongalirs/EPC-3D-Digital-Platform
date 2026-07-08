import type { Database } from '../db/index.js';
import { serializeJsonColumn } from '../lib/json.js';

export interface AuditEntry {
  action: string;
  subject: string;
  detail?: unknown;
  userId?: string | null;
}

export async function recordAudit(db: Database, entry: AuditEntry): Promise<void> {
  await db.knex('audit_log').insert({
    user_id: entry.userId ?? null,
    action: entry.action,
    subject: entry.subject,
    detail: entry.detail !== undefined ? serializeJsonColumn(entry.detail) : null,
  });
}

import type { Knex } from 'knex';

import type { Database, Dialect } from './index.js';

interface Migration {
  id: string;
  up: (knex: Knex.Transaction, dialect: Dialect) => Promise<void>;
}

/**
 * JSON-ish columns (`footprint_local`, `props`, `detail`) and bbox arrays are stored as
 * TEXT (JSON-serialized) in both dialects for simplicity — see repo/json.ts. The one
 * exception is `components.props`, which is real `jsonb` in Postgres so the GIN index the
 * task asks for (`jsonb_path_ops`) means something; SQLite has no such index.
 */
function jsonColumn(table: Knex.CreateTableBuilder, dialect: Dialect, name: string): void {
  if (dialect === 'pg') table.jsonb(name);
  else table.text(name);
}

const migrations: Migration[] = [
  {
    id: '001_init',
    up: async (knex, dialect) => {
      await knex.schema.createTable('sites', (table) => {
        table.uuid('id').primary();
        table.string('name').notNullable().unique();
        table.float('rotation_deg').nullable();
        table.string('anchor_convention').notNullable().defaultTo('model_origin');
        table.string('height_datum').nullable();
        table.timestamp('updated_at').defaultTo(knex.fn.now());
        table.text('updated_by').nullable();
      });

      await knex.schema.createTable('models', (table) => {
        table.uuid('id').primary();
        table.string('name').notNullable();
        table.string('source_format').notNullable();
        table.bigInteger('size_bytes').notNullable();
        table.string('status').notNullable();
        table.integer('current_revision').nullable();
        table.text('bbox_min').nullable();
        table.text('bbox_max').nullable();
        table.uuid('site_id').nullable().references('id').inTable('sites').onDelete('SET NULL');
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.text('error').nullable();
        // Not in the task's literal schema list, but required to fulfil "store to
        // /data/models/raw/ ... return model info": pointers to the raw uploaded
        // file(s) for this model (one row per upload GROUP, per invariant #5 — never blobs).
        table.text('source_files').notNullable();
      });

      await knex.schema.createTable('revisions', (table) => {
        table.uuid('model_id').notNullable().references('id').inTable('models').onDelete('CASCADE');
        table.integer('revision').notNullable();
        table.string('artifact_type').notNullable();
        table.text('artifact_path').notNullable();
        table.timestamp('published_at').defaultTo(knex.fn.now());
        table.primary(['model_id', 'revision']);
      });

      await knex.schema.createTable('components', (table) => {
        table.uuid('model_id').notNullable().references('id').inTable('models').onDelete('CASCADE');
        table.integer('revision').notNullable();
        table.text('linkage_key').notNullable();
        table.text('moniker').nullable();
        table.text('category').nullable();
        jsonColumn(table, dialect, 'props');
        table.text('bbox_min').nullable();
        table.text('bbox_max').nullable();
        table.primary(['model_id', 'revision', 'linkage_key']);
      });
      if (dialect === 'pg') {
        await knex.raw('CREATE INDEX components_props_gin_idx ON components USING GIN (props jsonb_path_ops)');
      }

      await knex.schema.createTable('zones', (table) => {
        table.uuid('id').primary();
        table.uuid('model_id').notNullable().references('id').inTable('models').onDelete('CASCADE');
        table.string('name').notNullable();
        table.string('color').notNullable();
        table.text('footprint_local').notNullable();
        table.float('zmin').notNullable();
        table.float('zmax').notNullable();
      });

      await knex.schema.createTable('zone_members', (table) => {
        table.uuid('zone_id').notNullable().references('id').inTable('zones').onDelete('CASCADE');
        table.text('linkage_key').notNullable();
        table.integer('revision').notNullable();
        table.primary(['zone_id', 'linkage_key', 'revision']);
      });

      await knex.schema.createTable('georefs', (table) => {
        // One active georef per model, looked up by model id alone (no :revision in the
        // endpoint paths) — model_id is the primary key, not part of a compound one.
        table.uuid('model_id').primary().references('id').inTable('models').onDelete('CASCADE');
        table.integer('revision').notNullable();
        table.uuid('site_id').nullable().references('id').inTable('sites').onDelete('SET NULL');
        table.float('anchor_lat').notNullable();
        table.float('anchor_lon').notNullable();
        table.float('height').nullable();
        table.string('height_datum').notNullable().defaultTo('unknown');
        table.float('rotation_deg').notNullable();
        table.string('rotation_source').notNullable();
        table.string('method').notNullable();
        table.string('anchor_convention').notNullable().defaultTo('model_origin');
        table.timestamp('updated_at').defaultTo(knex.fn.now());
      });

      await knex.schema.createTable('audit_log', (table) => {
        table.increments('id').primary();
        table.timestamp('ts').defaultTo(knex.fn.now());
        table.text('user_id').nullable();
        table.string('action').notNullable();
        table.string('subject').notNullable();
        jsonColumn(table, dialect, 'detail');
      });
    },
  },
  {
    id: '002_worker_queue_columns',
    up: async (knex) => {
      // processing_started_at: set when a worker claims a queued row, cleared on
      // completion/failure -- lets the queue detect a row stuck in 'processing' past
      // WORKER_STALL_TIMEOUT_MS (a crashed worker) and return it to 'queued'.
      // warnings: structured, non-fatal job warnings (e.g. "orientation defaulted", "join
      // coverage below 90%") surfaced by GET /api/models/{id}'s conversion dashboard --
      // distinct from `error`, which is set only on a hard job failure.
      await knex.schema.alterTable('models', (table) => {
        table.timestamp('processing_started_at').nullable();
        table.text('warnings').nullable();
      });
    },
  },
  {
    id: '003_revision_tiles_summary',
    up: async (knex, dialect) => {
      // Ops-visibility (Task 3 deliverable 4): a tiles job's completion summary (input size,
      // object count, tile count, max tile bytes, duration, repair-fired flag), previously
      // only in ephemeral warnings strings / worker logs. Null for 'glb' revisions.
      await knex.schema.alterTable('revisions', (table) => {
        jsonColumn(table, dialect, 'tiles_summary');
      });
    },
  },
];

export async function runMigrations(db: Database): Promise<void> {
  const { knex, dialect } = db;

  const hasMigrationsTable = await knex.schema.hasTable('schema_migrations');
  if (!hasMigrationsTable) {
    await knex.schema.createTable('schema_migrations', (table) => {
      table.string('id').primary();
      table.timestamp('applied_at').defaultTo(knex.fn.now());
    });
  }

  const appliedRows = await knex<{ id: string }>('schema_migrations').select('id');
  const applied = new Set(appliedRows.map((row) => row.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    await knex.transaction(async (trx) => {
      await migration.up(trx, dialect);
      await trx('schema_migrations').insert({ id: migration.id });
    });
  }
}

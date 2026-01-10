import { Pool, QueryResult, QueryResultRow } from 'pg';

const connectionString = process.env.DATABASE_URL;

export const dbEnabled = Boolean(connectionString);

export const pool = dbEnabled
  ? new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
    })
  : undefined;

let schemaEnsured = false;

export const ensureSchema = async (): Promise<void> => {
  if (!dbEnabled || schemaEnsured) return;

  await pool!.query(`
    create table if not exists bot_users (
      user_id bigint primary key,
      session jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists bot_polls (
      poll_id text primary key,
      metadata jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  schemaEnsured = true;
};

export const query = async <T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> => {
  if (!dbEnabled || !pool) {
    throw new Error('Database is not enabled. Set DATABASE_URL.');
  }
  await ensureSchema();
  return pool.query<T>(text, params);
};

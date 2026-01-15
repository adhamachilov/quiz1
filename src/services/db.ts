import { Pool, QueryResult, QueryResultRow } from 'pg';

const connectionString = process.env.DATABASE_URL;

export let dbEnabled = Boolean(connectionString);

export const pool = dbEnabled
  ? new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
    })
  : undefined;

if (pool) {
  pool.on('error', (err) => {
    void disableDb(err);
  });
}

let schemaEnsured = false;

const isConnectivityError = (err: any): boolean => {
  const code = String(err?.code ?? '');
  return (
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET'
  );
};

export const disableDb = async (reason?: any): Promise<void> => {
  if (!dbEnabled) return;
  dbEnabled = false;
  schemaEnsured = false;
  try {
    await pool?.end();
  } catch {
    // ignore
  }
  if (reason) {
    const msg = String(reason?.message ?? reason);
    console.error('⚠️ Database disabled due to connectivity error:', msg);
  }
};

export const ensureSchema = async (): Promise<void> => {
  if (!dbEnabled || schemaEnsured) return;

  try {
    await pool!.query(`
      create table if not exists bot_users (
        user_id bigint primary key,
        session jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists bot_payments (
        telegram_payment_charge_id text primary key,
        provider_payment_charge_id text,
        user_id bigint not null,
        currency text not null,
        total_amount bigint not null,
        invoice_payload text,
        created_at timestamptz not null default now()
      );

      create table if not exists bot_polls (
        poll_id text primary key,
        metadata jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
  } catch (err: any) {
    if (isConnectivityError(err)) {
      await disableDb(err);
      return;
    }
    throw err;
  }

  schemaEnsured = true;
};

export const query = async <T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> => {
  if (!dbEnabled || !pool) {
    throw new Error('Database is not enabled. Set DATABASE_URL.');
  }
  try {
    await ensureSchema();
    if (!dbEnabled) {
      throw new Error('Database is not enabled. Set DATABASE_URL.');
    }
    return await pool.query<T>(text, params);
  } catch (err: any) {
    if (isConnectivityError(err)) {
      await disableDb(err);
      throw new Error('DATABASE_UNAVAILABLE');
    }
    throw err;
  }
};

import { UserSession } from '../types/quiz.js';
import { dbEnabled, query } from './db.js';

export const getSession = async (userId: number): Promise<UserSession | undefined> => {
  if (!dbEnabled) return undefined;
  const res = await query<{ session: UserSession }>(
    'select session from bot_users where user_id = $1',
    [userId]
  );
  return res.rows[0]?.session;
};

export const setSession = async (userId: number, session: UserSession): Promise<void> => {
  if (!dbEnabled) return;
  await query(
    `insert into bot_users (user_id, session)
     values ($1, $2)
     on conflict (user_id) do update
     set session = excluded.session,
         updated_at = now()`,
    [userId, session]
  );
};

export const listUserIds = async (): Promise<number[]> => {
  if (!dbEnabled) return [];
  const res = await query<{ user_id: string }>('select user_id from bot_users');
  return res.rows.map(r => Number(r.user_id)).filter(n => Number.isFinite(n));
};

export const getStats = async (): Promise<{ users: number; withFile: number; processing: number }> => {
  if (!dbEnabled) return { users: 0, withFile: 0, processing: 0 };

  const usersRes = await query<{ count: string }>('select count(*)::text as count from bot_users');
  const withFileRes = await query<{ count: string }>(
    "select count(*)::text as count from bot_users where session ? 'fileText'"
  );
  const processingRes = await query<{ count: string }>(
    "select count(*)::text as count from bot_users where (session->>'isProcessing') = 'true'"
  );

  return {
    users: Number(usersRes.rows[0]?.count ?? 0),
    withFile: Number(withFileRes.rows[0]?.count ?? 0),
    processing: Number(processingRes.rows[0]?.count ?? 0),
  };
};

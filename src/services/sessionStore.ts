import { UserSession } from '../types/quiz.js';
import { dbEnabled, query } from './db.js';

export const getSession = async (userId: number): Promise<UserSession | undefined> => {
  if (!dbEnabled) return undefined;
  try {
    const res = await query<{ session: UserSession }>(
      'select session from bot_users where user_id = $1',
      [userId]
    );
    return res.rows[0]?.session;
  } catch {
    return undefined;
  }
};

export const getActiveUsersBetween = async (fromMs: number, toMs: number): Promise<number> => {
  if (!dbEnabled) return 0;
  try {
    const res = await query<{ count: string }>(
      "select count(*)::text as count from bot_users where coalesce((session->>'lastSeenAt')::bigint, 0) >= $1 and coalesce((session->>'lastSeenAt')::bigint, 0) < $2",
      [fromMs, toMs]
    );
    return Number(res.rows[0]?.count ?? 0) || 0;
  } catch {
    return 0;
  }
};

export const getPlanStats = async (): Promise<{ free: number; premium: number }> => {
  if (!dbEnabled) return { free: 0, premium: 0 };
  try {
    const premiumRes = await query<{ count: string }>(
      "select count(*)::text as count from bot_users where (coalesce((session->>'proUntil')::bigint, 0) > (extract(epoch from now()) * 1000)::bigint) or ((session->>'isPro') = 'true' and (session ? 'proUntil') = false)"
    );
    const premium = Number(premiumRes.rows[0]?.count ?? 0);
    const usersRes = await query<{ count: string }>('select count(*)::text as count from bot_users');
    const users = Number(usersRes.rows[0]?.count ?? 0);
    const free = Math.max(0, users - premium);
    return { free, premium };
  } catch {
    return { free: 0, premium: 0 };
  }
};

export const setSession = async (userId: number, session: UserSession): Promise<void> => {
  if (!dbEnabled) return;
  try {
    await query(
      `insert into bot_users (user_id, session)
       values ($1, $2)
       on conflict (user_id) do update
       set session = excluded.session,
           updated_at = now()`,
      [userId, session]
    );
  } catch {
    // ignore: runtime DB outages should not break bot flows
  }
};

export const listUserIds = async (): Promise<number[]> => {
  if (!dbEnabled) return [];
  try {
    const res = await query<{ user_id: string }>('select user_id from bot_users');
    return res.rows.map(r => Number(r.user_id)).filter(n => Number.isFinite(n));
  } catch {
    return [];
  }
};

export const getStats = async (): Promise<{ users: number; withFile: number; processing: number }> => {
  if (!dbEnabled) return { users: 0, withFile: 0, processing: 0 };

  try {
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
  } catch {
    return { users: 0, withFile: 0, processing: 0 };
  }
};

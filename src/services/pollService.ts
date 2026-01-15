import { PollMetadata } from "../types/quiz.js";
import { dbEnabled, query } from "./db.js";

// In-memory store for active polls
// Map<PollID, PollMetadata>
const pollStore = new Map<string, PollMetadata>();

export const savePoll = (pollId: string, metadata: PollMetadata) => {
  pollStore.set(pollId, metadata);

  if (dbEnabled) {
    void query(
      `insert into bot_polls (poll_id, metadata)
       values ($1, $2)
       on conflict (poll_id) do update
       set metadata = excluded.metadata,
           updated_at = now()`,
      [pollId, metadata]
    ).catch(() => {
      // ignore: we always keep an in-memory copy to allow poll flow to continue
    });
  }

  // Optional: Clean up old polls after 24 hours to prevent memory leaks
  setTimeout(() => {
    pollStore.delete(pollId);
  }, 24 * 60 * 60 * 1000);
};

export const getPoll = (pollId: string): PollMetadata | undefined => {
  if (dbEnabled) {
    // Synchronous signature kept for compatibility; callers already handle missing metadata.
    // For DB mode, poll answers are handled via a cached copy in memory at runtime.
    // The webhook path will use async retrieval via getPollAsync.
    return pollStore.get(pollId);
  }
  return pollStore.get(pollId);
};

export const getPollAsync = async (pollId: string): Promise<PollMetadata | undefined> => {
  if (!dbEnabled) return pollStore.get(pollId);
  try {
    const res = await query<{ metadata: PollMetadata }>(
      'select metadata from bot_polls where poll_id = $1',
      [pollId]
    );
    return res.rows[0]?.metadata ?? pollStore.get(pollId);
  } catch {
    return pollStore.get(pollId);
  }
};

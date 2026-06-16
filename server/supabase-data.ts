/**
 * supabase-data.ts
 * Server-side Supabase data operations using Service Role Key (bypasses RLS)
 * Handles: comments, ratings, reviews, user-data fields
 */

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? SUPABASE_ANON_KEY;

const SB_HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function sbFetch(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...SB_HEADERS, ...(options?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('[supabase-data] Error:', res.status, text);
    throw new Error(text);
  }
  return text ? JSON.parse(text) : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMENTS
// ═══════════════════════════════════════════════════════════════════════════════

export async function addComment(payload: {
  id: string;
  book_id: string;
  user_email: string;
  user_name: string;
  text: string;
  timestamp: number;
  reply_to?: string | null;
}): Promise<boolean> {
  const body: Record<string, unknown> = {
    id: payload.id,
    book_id: payload.book_id,
    user_email: payload.user_email,
    user_name: payload.user_name,
    text: payload.text,
    timestamp: payload.timestamp,
    likes: [],
    reports: [],
    is_hidden: false,
  };
  if (payload.reply_to) body.reply_to = payload.reply_to;
  await sbFetch('comments', { method: 'POST', body: JSON.stringify(body) });
  return true;
}

export async function deleteComment(commentId: string): Promise<boolean> {
  // Delete replies first
  await sbFetch(`comments?reply_to=eq.${encodeURIComponent(commentId)}`, { method: 'DELETE' });
  await sbFetch(`comments?id=eq.${encodeURIComponent(commentId)}`, { method: 'DELETE' });
  return true;
}

export async function toggleCommentLike(commentId: string, userEmail: string): Promise<boolean> {
  const data = await sbFetch(`comments?id=eq.${encodeURIComponent(commentId)}&select=likes`);
  if (!data || !Array.isArray(data) || data.length === 0) return false;
  const currentLikes: string[] = data[0].likes || [];
  const hasLiked = currentLikes.includes(userEmail);
  const newLikes = hasLiked
    ? currentLikes.filter((e: string) => e !== userEmail)
    : [...currentLikes, userEmail];
  await sbFetch(`comments?id=eq.${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ likes: newLikes }),
  });
  return true;
}

export async function reportComment(commentId: string, userEmail: string): Promise<boolean> {
  const data = await sbFetch(`comments?id=eq.${encodeURIComponent(commentId)}&select=reports`);
  if (!data || !Array.isArray(data) || data.length === 0) return false;
  const currentReports: string[] = data[0].reports || [];
  if (currentReports.includes(userEmail)) return true;
  await sbFetch(`comments?id=eq.${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ reports: [...currentReports, userEmail] }),
  });
  return true;
}

export async function toggleHideComment(commentId: string, currentHidden: boolean): Promise<boolean> {
  await sbFetch(`comments?id=eq.${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_hidden: !currentHidden }),
  });
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RATINGS
// ═══════════════════════════════════════════════════════════════════════════════

export async function rateBook(bookId: string, userEmail: string, rating: number): Promise<boolean> {
  await sbFetch('book_ratings', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      book_id: bookId,
      user_email: userEmail,
      rating,
      updated_at: new Date().toISOString(),
    }),
  });
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════════════════════════

export async function upsertReview(review: {
  id: string;
  book_id: string;
  user_email: string;
  user_name: string;
  strengths: string;
  weaknesses: string;
  conclusion: string;
  rating: number;
}): Promise<boolean> {
  await sbFetch('user_reviews', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      ...review,
      likes: [],
      reports: [],
      is_hidden: false,
      created_at: new Date().toISOString(),
    }),
  });
  return true;
}

export async function deleteReview(reviewId: string): Promise<boolean> {
  await sbFetch(`user_reviews?id=eq.${encodeURIComponent(reviewId)}`, { method: 'DELETE' });
  return true;
}

export async function toggleReviewLike(reviewId: string, userEmail: string): Promise<boolean> {
  const data = await sbFetch(`user_reviews?id=eq.${encodeURIComponent(reviewId)}&select=likes`);
  if (!data || !Array.isArray(data) || data.length === 0) return false;
  const currentLikes: string[] = data[0].likes || [];
  const hasLiked = currentLikes.includes(userEmail);
  const updatedLikes = hasLiked
    ? currentLikes.filter((e: string) => e !== userEmail)
    : [...currentLikes, userEmail];
  await sbFetch(`user_reviews?id=eq.${encodeURIComponent(reviewId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ likes: updatedLikes }),
  });
  return true;
}

export async function reportReview(reviewId: string, userEmail: string): Promise<boolean> {
  const data = await sbFetch(`user_reviews?id=eq.${encodeURIComponent(reviewId)}&select=reports`);
  if (!data || !Array.isArray(data) || data.length === 0) return false;
  const currentReports: string[] = data[0].reports || [];
  if (currentReports.includes(userEmail)) return true;
  await sbFetch(`user_reviews?id=eq.${encodeURIComponent(reviewId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ reports: [...currentReports, userEmail] }),
  });
  return true;
}

export async function toggleHideReview(reviewId: string, currentlyHidden: boolean): Promise<boolean> {
  await sbFetch(`user_reviews?id=eq.${encodeURIComponent(reviewId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_hidden: !currentlyHidden }),
  });
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER DATA (favorites, challenge_progress, week_starts, book_ratings, etc.)
// ═══════════════════════════════════════════════════════════════════════════════

export async function updateUserData(email: string, fields: Record<string, any>): Promise<boolean> {
  const result = await sbFetch(`app_users?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
  // result is array; empty array means RLS blocked (shouldn't happen with service key)
  if (Array.isArray(result) && result.length === 0) {
    console.error('[supabase-data] updateUserData returned empty - user not found:', email);
    return false;
  }
  return true;
}

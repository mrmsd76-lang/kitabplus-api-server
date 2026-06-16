/**
 * supabase-session-users.ts
 * إدارة جدول users (جلسات OAuth) عبر Supabase REST API
 * يستبدل الاتصال المباشر بـ PostgreSQL (drizzle-orm) الذي يفشل بسبب IPv6
 */

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const OWNER_OPEN_ID = process.env.OWNER_OPEN_ID ?? '';

const SB_HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

export type SessionUser = {
  id: number;
  openId: string;
  name: string | null;
  email: string | null;
  loginMethod: string | null;
  role: string;
  createdAt: string;
  updatedAt: string;
  lastSignedIn: string;
};

async function sbFetch(path: string, options?: RequestInit): Promise<any> {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...SB_HEADERS, ...(options?.headers ?? {}) },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase REST error ${res.status}: ${text}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Upsert a user in the `users` table via Supabase REST API
 */
export async function sbUpsertSessionUser(user: {
  openId: string;
  name?: string | null;
  email?: string | null;
  loginMethod?: string | null;
  role?: string;
  lastSignedIn?: Date;
}): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[SessionUsers] Supabase URL or key not configured, skipping upsert');
    return;
  }

  const now = new Date().toISOString();
  const role = user.role ?? (user.openId === OWNER_OPEN_ID ? 'admin' : 'user');
  const lastSignedIn = user.lastSignedIn ? user.lastSignedIn.toISOString() : now;

  // Build the body — only include defined fields
  const body: Record<string, unknown> = {
    openId: user.openId,
    role,
    lastSignedIn,
    updatedAt: now,
  };

  if (user.name !== undefined) body.name = user.name ?? null;
  if (user.email !== undefined) body.email = user.email ?? null;
  if (user.loginMethod !== undefined) body.loginMethod = user.loginMethod ?? null;

  try {
    // Use POST with Prefer: resolution=merge-duplicates for upsert (ON CONFLICT DO UPDATE)
    // The Prefer header must be set correctly for PostgREST upsert
    const url = `${SUPABASE_URL}/rest/v1/users`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase REST error ${res.status}: ${text}`);
    }
    console.log(`[SessionUsers] Upserted user ${user.openId}`);
  } catch (error: any) {
    console.error('[SessionUsers] Failed to upsert user:', error?.message);
    throw error;
  }
}

/**
 * Get a user from the `users` table by openId via Supabase REST API
 */
export async function sbGetSessionUserByOpenId(openId: string): Promise<SessionUser | undefined> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[SessionUsers] Supabase URL or key not configured');
    return undefined;
  }

  try {
    const encodedOpenId = encodeURIComponent(openId);
    const result = await sbFetch(`users?openId=eq.${encodedOpenId}&limit=1`, {
      method: 'GET',
    });

    if (!result || result.length === 0) return undefined;

    const row = result[0];
    return {
      id: row.id,
      openId: row.openId,
      name: row.name ?? null,
      email: row.email ?? null,
      loginMethod: row.loginMethod ?? null,
      role: row.role ?? 'user',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastSignedIn: row.lastSignedIn,
    };
  } catch (error: any) {
    console.error('[SessionUsers] Failed to get user by openId:', error?.message);
    return undefined;
  }
}

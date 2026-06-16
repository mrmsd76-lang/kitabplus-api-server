/**
 * supabase-users.ts
 * إدارة المستخدمين (app_users) عبر Supabase REST API
 * يستبدل استخدام MySQL لجدول app_users
 */

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
// مفتاح الخدمة يتجاوز RLS ويُستخدم للعمليات الكتابية من الخادم
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? SUPABASE_ANON_KEY;

const SB_READ_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

// للعمليات الكتابية (PATCH/POST/DELETE) نستخدم service role key لتجاوز RLS
const SB_WRITE_HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

// للتوافق مع الكود القديم
const SB_HEADERS = SB_READ_HEADERS;


// ─── Types ───────────────────────────────────────────────────────────────────
export type SbAppUser = {
  id: number;
  name: string;
  email: string;
  password: string;
  is_admin: boolean;
  subscription_plan: string;
  subscription_expiry: string | null;
  created_at: string;
  updated_at: string;
  book_suggestions?: Array<{
    id: string;
    bookTitle: string;
    author: string;
    reason: string;
    submittedAt: string;
    status: string;
  }>;
};

// ─── Helper ───────────────────────────────────────────────────────────────────
// يستخدم service role key للعمليات الكتابية (PATCH/POST/DELETE) لتجاوز RLS
async function sbFetch(path: string, options?: RequestInit): Promise<any> {
  const isWrite = options?.method && ['PATCH','POST','PUT','DELETE'].includes(options.method.toUpperCase());
  const headers = isWrite ? SB_WRITE_HEADERS : SB_READ_HEADERS;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers, ...(options?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text ? JSON.parse(text) : null;
}

// ─── CRUD Functions ───────────────────────────────────────────────────────────

export async function sbGetAppUserByEmail(email: string): Promise<SbAppUser | undefined> {
  const result = await sbFetch(
    `app_users?email=eq.${encodeURIComponent(email.toLowerCase())}&limit=1`
  );
  return Array.isArray(result) && result.length > 0 ? result[0] : undefined;
}

export async function sbGetAppUserById(id: number): Promise<SbAppUser | undefined> {
  const result = await sbFetch(`app_users?id=eq.${id}&limit=1`);
  return Array.isArray(result) && result.length > 0 ? result[0] : undefined;
}

export async function sbCreateAppUser(data: {
  name: string;
  email: string;
  password: string;
  is_admin?: boolean;
  subscription_plan?: string;
}): Promise<number> {
  const result = await sbFetch("app_users", {
    method: "POST",
    body: JSON.stringify({
      name: data.name,
      email: data.email.toLowerCase(),
      password: data.password,
      is_admin: data.is_admin ?? false,
      subscription_plan: data.subscription_plan ?? "free",
    }),
  });
  const row = Array.isArray(result) ? result[0] : result;
  return row.id as number;
}

export async function sbUpdateAppUserSubscription(
  id: number,
  plan: string,
  expiry: Date | null
): Promise<void> {
  await sbFetch(`app_users?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      subscription_plan: plan,
      subscription_expiry: expiry ? expiry.toISOString() : null,
      updated_at: new Date().toISOString(),
    }),
  });
}

export async function sbUpdateAppUserPassword(id: number, hashedPassword: string): Promise<void> {
  await sbFetch(`app_users?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify({ password: hashedPassword, updated_at: new Date().toISOString() }),
  });
}

export async function sbGetAllAppUsers(): Promise<SbAppUser[]> {
  return sbFetch("app_users?select=*&order=created_at.asc");
}

export async function sbUpdateAppUserProfile(
  id: number,
  data: { name?: string; email?: string; is_admin?: boolean }
): Promise<void> {
  await sbFetch(`app_users?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify({ ...data, updated_at: new Date().toISOString() }),
  });
}

export async function sbUpdateBookSuggestions(
  id: number,
  suggestions: SbAppUser['book_suggestions']
): Promise<void> {
  await sbFetch(`app_users?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify({ book_suggestions: suggestions, updated_at: new Date().toISOString() }),
  });
}

export async function sbDeleteAppUser(id: number): Promise<void> {
  await sbFetch(`app_users?id=eq.${id}`, { method: "DELETE" });
}

export async function sbGetUsersExpiringWithinDays(days: number): Promise<SbAppUser[]> {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  return sbFetch(
    `app_users?subscription_expiry=gte.${now}&subscription_expiry=lte.${future}&subscription_plan=neq.free`
  );
}

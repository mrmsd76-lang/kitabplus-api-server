/**
 * db.ts — Supabase REST API layer
 * All database operations use Supabase PostgREST instead of direct PostgreSQL connection.
 * This avoids IPv6/IPv4 connectivity issues on Render.
 */
import { ENV } from "./_core/env";
import {
  sbGetAppUserByEmail, sbGetAppUserById, sbCreateAppUser,
  sbUpdateAppUserSubscription, sbUpdateAppUserPassword,
  sbGetAllAppUsers, sbUpdateAppUserProfile, sbDeleteAppUser, sbUpdateBookSuggestions,
  sbGetUsersExpiringWithinDays, SbAppUser
} from "./supabase-users";
import { sbUpsertSessionUser, sbGetSessionUserByOpenId, type SessionUser } from "./supabase-session-users";

// Re-export types for backward compatibility
import type { AppInstall, AppUser, DiscountCode, InsertAppInstall, InsertAppUser, InsertDiscountCode, InsertPaymentHistoryRecord, InsertPaymentEvent, InsertUser, PaymentEvent, PaymentHistoryRecord, PushToken, User } from "../drizzle/schema";

// ─── Supabase REST API Setup ─────────────────────────────────────────────────
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? SUPABASE_ANON_KEY;

const SB_HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

/** Generic Supabase REST fetch helper — always uses service role key */
async function sbFetch(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...SB_HEADERS, ...(options?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    console.warn(`[sbFetch] Error ${res.status}: ${text.substring(0, 200)}`);
    throw new Error(`Supabase REST error: ${res.status} - ${text.substring(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

// ─── Legacy getDb (returns null — kept for backward compat) ──────────────────
export async function getDb() {
  return null;
}

// ─── Users (OAuth login) ─────────────────────────────────────────────────────
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }
  await sbUpsertSessionUser({
    openId: user.openId,
    name: user.name,
    email: user.email,
    loginMethod: user.loginMethod,
    role: user.role ?? (user.openId === ENV.ownerOpenId ? 'admin' : undefined),
    lastSignedIn: user.lastSignedIn instanceof Date ? user.lastSignedIn : user.lastSignedIn ? new Date(user.lastSignedIn as string) : undefined,
  });
}

export async function getUserByOpenId(openId: string): Promise<User | undefined> {
  const user = await sbGetSessionUserByOpenId(openId);
  if (!user) return undefined;
  return {
    id: user.id,
    openId: user.openId,
    name: user.name,
    email: user.email,
    loginMethod: user.loginMethod,
    role: user.role as 'user' | 'admin',
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt),
    lastSignedIn: new Date(user.lastSignedIn),
  } as User;
}

// ── App Users (email/password auth) — via Supabase ──────────────────────────
function mapSbUser(u: SbAppUser): AppUser {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    password: u.password,
    isAdmin: u.is_admin ? '1' : '0',
    subscriptionPlan: u.subscription_plan,
    subscriptionExpiry: u.subscription_expiry ? new Date(u.subscription_expiry) : null,
    createdAt: new Date(u.created_at),
    bookSuggestions: u.book_suggestions ?? [],
  } as AppUser & { bookSuggestions: SbAppUser['book_suggestions'] };
}

export async function getAppUserByEmail(email: string): Promise<AppUser | undefined> {
  const u = await sbGetAppUserByEmail(email);
  return u ? mapSbUser(u) : undefined;
}

export async function createAppUser(data: InsertAppUser): Promise<number> {
  return sbCreateAppUser({
    name: data.name ?? '',
    email: data.email,
    password: data.password ?? '',
    is_admin: data.isAdmin === '1',
    subscription_plan: data.subscriptionPlan ?? 'free',
  });
}

export async function getAppUserById(id: number): Promise<AppUser | undefined> {
  const u = await sbGetAppUserById(id);
  return u ? mapSbUser(u) : undefined;
}

export async function updateAppUserSubscription(
  id: number,
  plan: string,
  expiry: Date | null
): Promise<void> {
  await sbUpdateAppUserSubscription(id, plan, expiry);
}

// ── Discount Codes (via Supabase REST) ───────────────────────────────────────
export async function getDiscountCodeByCode(code: string): Promise<DiscountCode | undefined> {
  const rows = await sbFetch(`discount_codes?code=eq.${encodeURIComponent(code.toUpperCase().trim())}&limit=1`);
  if (!rows || rows.length === 0) return undefined;
  return mapDiscountRow(rows[0]);
}

export async function createDiscountCode(data: InsertDiscountCode): Promise<number> {
  const rows = await sbFetch('discount_codes', {
    method: 'POST',
    body: JSON.stringify({
      code: data.code.toUpperCase().trim(),
      "discountPercent": data.discountPercent ?? 10,
      "maxUses": data.maxUses ?? 100,
      "usedCount": 0,
      "isActive": data.isActive ?? '1',
      "expiresAt": data.expiresAt ?? null,
    }),
  });
  return rows?.[0]?.id ?? 0;
}

export async function incrementDiscountCodeUsage(id: number): Promise<void> {
  // First get current count
  const rows = await sbFetch(`discount_codes?id=eq.${id}&select=usedCount`);
  if (!rows || rows.length === 0) return;
  const current = rows[0].usedCount ?? 0;
  await sbFetch(`discount_codes?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ "usedCount": current + 1 }),
  });
}

export async function getAllDiscountCodes(): Promise<DiscountCode[]> {
  const rows = await sbFetch('discount_codes?order=createdAt.asc');
  if (!rows) return [];
  return rows.map(mapDiscountRow);
}

export async function toggleDiscountCodeStatus(id: number, isActive: '0' | '1'): Promise<void> {
  await sbFetch(`discount_codes?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ "isActive": isActive }),
  });
}

export async function deleteDiscountCode(id: number): Promise<void> {
  await sbFetch(`discount_codes?id=eq.${id}`, { method: 'DELETE' });
}

function mapDiscountRow(r: any): DiscountCode {
  return {
    id: r.id,
    code: r.code,
    discountPercent: r.discountPercent,
    maxUses: r.maxUses,
    usedCount: r.usedCount,
    isActive: r.isActive,
    expiresAt: r.expiresAt ? new Date(r.expiresAt) : null,
    createdAt: new Date(r.createdAt),
  } as DiscountCode;
}

// ── App User Management ──────────────────────────────────────────────────────
export async function updateAppUserPassword(id: number, hashedPassword: string): Promise<void> {
  await sbUpdateAppUserPassword(id, hashedPassword);
}

export async function getAllAppUsers(): Promise<AppUser[]> {
  const users = await sbGetAllAppUsers();
  return users.map(mapSbUser);
}

export async function updateAppUserProfile(
  id: number,
  data: { name?: string; email?: string; isAdmin?: '0' | '1' }
): Promise<void> {
  await sbUpdateAppUserProfile(id, {
    name: data.name,
    email: data.email,
    is_admin: data.isAdmin === '1',
  });
}

export async function deleteAppUser(id: number): Promise<void> {
  await sbDeleteAppUser(id);
}

export async function updateBookSuggestions(
  userId: number,
  suggestions: SbAppUser['book_suggestions']
): Promise<void> {
  await sbUpdateBookSuggestions(userId, suggestions);
}

export async function getUsersExpiringWithinDays(days: number): Promise<AppUser[]> {
  const users = await sbGetUsersExpiringWithinDays(days);
  return users.map(mapSbUser);
}

// ── Payment Events (via Supabase REST) ───────────────────────────────────────
export async function insertPaymentEvent(data: InsertPaymentEvent): Promise<number> {
  const rows = await sbFetch('payment_events', {
    method: 'POST',
    body: JSON.stringify({
      gateway: data.gateway,
      "eventType": data.eventType,
      "chargeId": data.chargeId,
      "orderId": data.orderId ?? null,
      "customerEmail": data.customerEmail ?? null,
      amount: data.amount ?? null,
      currency: data.currency ?? null,
      plan: data.plan ?? null,
      "userId": data.userId ?? null,
      status: data.status,
      "errorMessage": data.errorMessage ?? null,
      "rawPayload": data.rawPayload ?? null,
    }),
  });
  return rows?.[0]?.id ?? 0;
}

export async function getPaymentEvents(limit = 100): Promise<PaymentEvent[]> {
  const rows = await sbFetch(`payment_events?order=createdAt.asc&limit=${limit}`);
  if (!rows) return [];
  return rows.map(mapPaymentEventRow);
}

export async function getPaymentEventsByEmail(email: string): Promise<PaymentEvent[]> {
  const rows = await sbFetch(`payment_events?customerEmail=eq.${encodeURIComponent(email)}&order=createdAt.asc`);
  if (!rows) return [];
  return rows.map(mapPaymentEventRow);
}

function mapPaymentEventRow(r: any): PaymentEvent {
  return {
    ...r,
    createdAt: new Date(r.createdAt),
  } as PaymentEvent;
}

// ── Push Tokens (via Supabase REST) ──────────────────────────────────────────
export async function upsertPushToken(userId: number, token: string, platform?: string): Promise<void> {
  // Delete old token for this user
  await sbFetch(`push_tokens?userId=eq.${userId}`, { method: 'DELETE' });
  // Insert new token
  await sbFetch('push_tokens', {
    method: 'POST',
    body: JSON.stringify({
      "userId": userId,
      token,
      platform: platform ?? null,
    }),
  });
}

export async function getPushTokenByUserId(userId: number): Promise<PushToken | null> {
  const rows = await sbFetch(`push_tokens?userId=eq.${userId}&limit=1`);
  if (!rows || rows.length === 0) return null;
  return mapPushTokenRow(rows[0]);
}

export async function getPushTokensForExpiringUsers(days: number): Promise<Array<{ userId: number; token: string; name: string; email: string; subscriptionExpiry: Date }>> {
  // Get all push tokens
  const tokens = await sbFetch('push_tokens?select=userId,token');
  if (!tokens || tokens.length === 0) return [];
  
  // Get all app users with subscriptions
  const users = await sbGetAllAppUsers();
  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  
  // Filter users whose subscription expires within the range
  const tokenMap = new Map<number, string>();
  for (const t of tokens) {
    tokenMap.set(t.userId, t.token);
  }
  
  const results: Array<{ userId: number; token: string; name: string; email: string; subscriptionExpiry: Date }> = [];
  for (const u of users) {
    if (!u.subscription_expiry || u.subscription_plan === 'free') continue;
    const expiry = new Date(u.subscription_expiry);
    if (expiry > now && expiry <= future) {
      const token = tokenMap.get(u.id);
      if (token) {
        results.push({
          userId: u.id,
          token,
          name: u.name || 'عزيزي المشترك',
          email: u.email,
          subscriptionExpiry: expiry,
        });
      }
    }
  }
  return results;
}

export async function getAllSubscriberPushTokens(): Promise<Array<{ userId: number; token: string; name: string }>> {
  const tokens = await sbFetch('push_tokens?select=userId,token');
  if (!tokens || tokens.length === 0) return [];
  
  const users = await sbGetAllAppUsers();
  const now = new Date();
  const tokenMap = new Map<number, string>();
  for (const t of tokens) {
    tokenMap.set(t.userId, t.token);
  }
  
  const results: Array<{ userId: number; token: string; name: string }> = [];
  for (const u of users) {
    if (u.subscription_plan === 'free') continue;
    if (!u.subscription_expiry) continue;
    const expiry = new Date(u.subscription_expiry);
    if (expiry <= now) continue;
    const token = tokenMap.get(u.id);
    if (token) {
      results.push({ userId: u.id, token, name: u.name || 'عزيزي المشترك' });
    }
  }
  return results;
}

export async function getAdminPushTokens(): Promise<Array<{ userId: number; token: string; name: string }>> {
  const tokens = await sbFetch('push_tokens?select=userId,token');
  if (!tokens || tokens.length === 0) return [];
  
  const users = await sbGetAllAppUsers();
  const tokenMap = new Map<number, string>();
  for (const t of tokens) {
    tokenMap.set(t.userId, t.token);
  }
  
  const results: Array<{ userId: number; token: string; name: string }> = [];
  for (const u of users) {
    if (!u.is_admin) continue;
    const token = tokenMap.get(u.id);
    if (token) {
      results.push({ userId: u.id, token, name: u.name || 'المدير' });
    }
  }
  return results;
}

export async function deletePushToken(userId: number): Promise<void> {
  await sbFetch(`push_tokens?userId=eq.${userId}`, { method: 'DELETE' });
}

function mapPushTokenRow(r: any): PushToken {
  return {
    id: r.id,
    userId: r.userId,
    token: r.token,
    platform: r.platform,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  } as PushToken;
}

// ── Payment History (via Supabase REST) ──────────────────────────────────────
export async function insertPaymentHistory(data: InsertPaymentHistoryRecord): Promise<number> {
  const rows = await sbFetch('payment_history', {
    method: 'POST',
    body: JSON.stringify({
      "userId": data.userId ?? null,
      "customerEmail": data.customerEmail ?? null,
      gateway: data.gateway,
      "chargeId": data.chargeId ?? null,
      amount: data.amount,
      currency: data.currency ?? 'SAR',
      plan: data.plan ?? null,
      status: data.status,
      "cardLast4": data.cardLast4 ?? null,
      "cardBrand": data.cardBrand ?? null,
      "referenceId": data.referenceId ?? null,
      "errorMessage": data.errorMessage ?? null,
    }),
  });
  return rows?.[0]?.id ?? 0;
}

export async function getPaymentHistoryByUserId(userId: number, limit = 50): Promise<PaymentHistoryRecord[]> {
  const user = await getAppUserById(userId);
  const userEmail = user?.email;
  
  let rows: any[];
  if (userEmail) {
    rows = await sbFetch(`payment_history?or=(userId.eq.${userId},customerEmail.eq.${encodeURIComponent(userEmail)})&order=createdAt.desc&limit=${limit}`);
  } else {
    rows = await sbFetch(`payment_history?userId=eq.${userId}&order=createdAt.desc&limit=${limit}`);
  }
  if (!rows) return [];
  return rows.map(mapPaymentHistoryRow);
}

export async function deletePaymentHistoryById(id: number): Promise<boolean> {
  try {
    await sbFetch(`payment_history?id=eq.${id}`, { method: 'DELETE' });
    return true;
  } catch {
    return false;
  }
}

export async function getPaymentHistoryByEmail(email: string, limit = 50): Promise<PaymentHistoryRecord[]> {
  const rows = await sbFetch(`payment_history?customerEmail=eq.${encodeURIComponent(email.toLowerCase().trim())}&order=createdAt.desc&limit=${limit}`);
  if (!rows) return [];
  return rows.map(mapPaymentHistoryRow);
}

export async function getAllPaymentHistory(limit = 200): Promise<PaymentHistoryRecord[]> {
  const rows = await sbFetch(`payment_history?order=createdAt.desc&limit=${limit}`);
  if (!rows) return [];
  return rows.map(mapPaymentHistoryRow);
}

export async function getPendingStcPayments(limit = 100): Promise<PaymentHistoryRecord[]> {
  const rows = await sbFetch(`payment_history?gateway=eq.stcpay&status=eq.pending&order=createdAt.desc&limit=${limit}`);
  if (!rows) return [];
  return rows.map(mapPaymentHistoryRow);
}

export async function getPendingPayPalPayments(limit = 100): Promise<PaymentHistoryRecord[]> {
  const rows = await sbFetch(`payment_history?gateway=eq.paypal&status=eq.pending&order=createdAt.desc&limit=${limit}`);
  if (!rows) return [];
  return rows.map(mapPaymentHistoryRow);
}

export async function getPendingWisePayments(limit = 100): Promise<PaymentHistoryRecord[]> {
  const rows = await sbFetch(`payment_history?gateway=eq.wise&status=eq.pending&order=createdAt.desc&limit=${limit}`);
  if (!rows) return [];
  return rows.map(mapPaymentHistoryRow);
}

export async function getPendingCryptoPayments(limit = 100): Promise<PaymentHistoryRecord[]> {
  const rows = await sbFetch(`payment_history?gateway=eq.crypto&status=eq.pending&order=createdAt.desc&limit=${limit}`);
  if (!rows) return [];
  return rows.map(mapPaymentHistoryRow);
}

export async function getPendingIbanPayments(limit = 100): Promise<PaymentHistoryRecord[]> {
  const rows = await sbFetch(`payment_history?gateway=eq.iban&status=eq.pending&order=createdAt.desc&limit=${limit}`);
  if (!rows) return [];
  return rows.map(mapPaymentHistoryRow);
}

export async function updatePaymentHistoryStatus(
  id: number,
  status: 'success' | 'failed' | 'pending' | 'refunded'
): Promise<void> {
  await sbFetch(`payment_history?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export async function getPaymentHistoryById(id: number): Promise<PaymentHistoryRecord | null> {
  const rows = await sbFetch(`payment_history?id=eq.${id}&limit=1`);
  if (!rows || rows.length === 0) return null;
  return mapPaymentHistoryRow(rows[0]);
}

function mapPaymentHistoryRow(r: any): PaymentHistoryRecord {
  return {
    ...r,
    createdAt: new Date(r.createdAt),
  } as PaymentHistoryRecord;
}

// ── App Installs (via Supabase REST) ─────────────────────────────────────────
export async function recordAppInstall(data: InsertAppInstall): Promise<void> {
  try {
    // Try to find existing record
    const existing = await sbFetch(`app_installs?deviceId=eq.${encodeURIComponent(data.deviceId)}&limit=1`);
    if (existing && existing.length > 0) {
      // Update existing
      await sbFetch(`app_installs?deviceId=eq.${encodeURIComponent(data.deviceId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          "lastOpenAt": new Date().toISOString(),
          "openCount": (existing[0].openCount ?? 1) + 1,
          "appVersion": data.appVersion ?? existing[0].appVersion,
        }),
      });
    } else {
      // Insert new
      await sbFetch('app_installs', {
        method: 'POST',
        body: JSON.stringify({
          "deviceId": data.deviceId,
          "appVersion": data.appVersion ?? null,
          platform: data.platform ?? null,
          "deviceModel": data.deviceModel ?? null,
          country: data.country ?? null,
        }),
      });
    }
  } catch (err) {
    console.warn("[AppInstalls] Failed to record:", err);
  }
}

export async function getInstallStats(sinceDate?: Date): Promise<{
  total: number;
  byPlatform: { platform: string; count: number }[];
  byVersion: { version: string; count: number }[];
  byCountry: { country: string; count: number }[];
  recent: AppInstall[];
  dailyCounts: { date: string; count: number }[];
}> {
  let query = 'app_installs?order=firstOpenAt.desc';
  if (sinceDate) {
    query += `&firstOpenAt=gte.${sinceDate.toISOString()}`;
  }
  const allInstalls = await sbFetch(query);
  if (!allInstalls || allInstalls.length === 0) {
    return { total: 0, byPlatform: [], byVersion: [], byCountry: [], recent: [], dailyCounts: [] };
  }
  
  const total = allInstalls.length;
  const recent = allInstalls.slice(0, 50).map(mapInstallRow);
  
  const platformMap: Record<string, number> = {};
  const versionMap: Record<string, number> = {};
  const dayMap: Record<string, number> = {};
  const countryMap: Record<string, number> = {};
  
  for (const r of allInstalls) {
    const p = r.platform ?? 'unknown';
    platformMap[p] = (platformMap[p] ?? 0) + 1;
    const v = r.appVersion ?? 'unknown';
    versionMap[v] = (versionMap[v] ?? 0) + 1;
    const d = (r.firstOpenAt ?? '').slice(0, 10);
    if (d) dayMap[d] = (dayMap[d] ?? 0) + 1;
    if (r.country) {
      const c = r.country.toUpperCase();
      countryMap[c] = (countryMap[c] ?? 0) + 1;
    }
  }
  
  return {
    total,
    byPlatform: Object.entries(platformMap).map(([platform, count]) => ({ platform, count })),
    byVersion: Object.entries(versionMap).map(([version, count]) => ({ version, count })).sort((a, b) => b.count - a.count),
    byCountry: Object.entries(countryMap).map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count),
    recent,
    dailyCounts: Object.entries(dayMap).sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count })),
  };
}

function mapInstallRow(r: any): AppInstall {
  return {
    id: r.id,
    deviceId: r.deviceId,
    appVersion: r.appVersion,
    platform: r.platform,
    deviceModel: r.deviceModel,
    country: r.country,
    firstOpenAt: new Date(r.firstOpenAt),
    lastOpenAt: new Date(r.lastOpenAt),
    openCount: r.openCount,
  } as AppInstall;
}

// ── Referrals (نظام الإحالة - تم حذفه) ────────────────────────────────────────
export async function getOrCreateReferralCode(_userId: number): Promise<string> {
  return '';
}
export async function validateReferralCode(_code: string): Promise<{ valid: boolean; referrerId?: number }> {
  return { valid: false };
}
export async function rewardReferrer(_referrerId: number, _extraDays: number): Promise<void> {
  return;
}
export async function getReferralStats(): Promise<{
  total: number;
  pending: number;
  subscribed: number;
  rewarded: number;
  topReferrers: { referrerId: number; name: string; email: string; count: number }[];
  recent: any[];
}> {
  return { total: 0, pending: 0, subscribed: 0, rewarded: 0, topReferrers: [], recent: [] };
}
export async function getUserReferrals(_userId: number): Promise<any[]> {
  return [];
}
export async function applyReferralOnSubscription(_code: string, _userId: number, _email: string): Promise<{ referrerId: number } | null> {
  return null;
}

import { eq, sql, desc, and, count, or, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { ENV } from "./_core/env";
import { appInstalls, appUsers, discountCodes, paymentEvents, paymentHistory, pushTokens, users } from "../drizzle/schema";
import type { AppInstall, AppUser, DiscountCode, InsertAppInstall, InsertAppUser, InsertDiscountCode, InsertPaymentHistoryRecord, InsertPaymentEvent, InsertUser, PaymentEvent, PaymentHistoryRecord, PushToken, User } from "../drizzle/schema";
import {
  sbGetAppUserByEmail, sbGetAppUserById, sbCreateAppUser,
  sbUpdateAppUserSubscription, sbUpdateAppUserPassword,
  sbGetAllAppUsers, sbUpdateAppUserProfile, sbDeleteAppUser, sbUpdateBookSuggestions,
  sbGetUsersExpiringWithinDays, SbAppUser
} from "./supabase-users";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const client = postgres(process.env.DATABASE_URL, { ssl: "require", max: 5 });
      _db = drizzle(client);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onConflictDoUpdate({
      target: users.openId,
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// ── App Users (email/password auth) — via Supabase ──────────────────────────
// Map SbAppUser → AppUser shape for backward compatibility
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

// ── Discount Codes ────────────────────────────────────────────────────────────
export async function getDiscountCodeByCode(code: string): Promise<DiscountCode | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(discountCodes)
    .where(eq(discountCodes.code, code.toUpperCase().trim()))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createDiscountCode(data: InsertDiscountCode): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(discountCodes).values({
    ...data,
    code: data.code.toUpperCase().trim(),
  });
  return (result as any).insertId as number;
}

export async function incrementDiscountCodeUsage(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(discountCodes)
    .set({ usedCount: sql`${discountCodes.usedCount} + 1` })
    .where(eq(discountCodes.id, id));
}

export async function getAllDiscountCodes(): Promise<DiscountCode[]> {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(discountCodes).orderBy(discountCodes.createdAt);
}

export async function toggleDiscountCodeStatus(id: number, isActive: '0' | '1'): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(discountCodes).set({ isActive }).where(eq(discountCodes.id, id));
}

export async function deleteDiscountCode(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(discountCodes).where(eq(discountCodes.id, id));
}

export async function updateAppUserPassword(id: number, hashedPassword: string): Promise<void> {
  await sbUpdateAppUserPassword(id, hashedPassword);
}

// ── Admin: User Management ────────────────────────────────────────────────────────────
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

/** جلب المستخدمين الذين ينتهي اشتراكهم خلال N يوماً القادمة */
export async function getUsersExpiringWithinDays(days: number): Promise<AppUser[]> {
  const users = await sbGetUsersExpiringWithinDays(days);
  return users.map(mapSbUser);
}

// ── Payment Events ────────────────────────────────────────────────────────────
export async function insertPaymentEvent(data: InsertPaymentEvent): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const result = await db.insert(paymentEvents).values(data);
  return (result as any).insertId as number;
}

export async function getPaymentEvents(limit = 100): Promise<PaymentEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(paymentEvents).orderBy(paymentEvents.createdAt).limit(limit);
}

export async function getPaymentEventsByEmail(email: string): Promise<PaymentEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(paymentEvents)
    .where(eq(paymentEvents.customerEmail, email))
    .orderBy(paymentEvents.createdAt);
}

// ── Push Tokens ────────────────────────────────────────────────────────────
/** حفظ أو تحديث Push Token لمستخدم */
export async function upsertPushToken(userId: number, token: string, platform?: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  // حذف التوكن القديم لهذا المستخدم إن وجد
  await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
  // حفظ التوكن الجديد
  await db.insert(pushTokens).values({ userId, token, platform: platform ?? null });
}

/** جلب Push Token لمستخدم محدد */
export async function getPushTokenByUserId(userId: number): Promise<PushToken | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(pushTokens).where(eq(pushTokens.userId, userId)).limit(1);
  return rows[0] ?? null;
}

/** جلب جميع Push Tokens للمستخدمين الذين ينتهي اشتراكهم خلال N أيام */
export async function getPushTokensForExpiringUsers(days: number): Promise<Array<{ userId: number; token: string; name: string; email: string; subscriptionExpiry: Date }>> {
  const db = await getDb();
  if (!db) return [];
  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      userId: appUsers.id,
      token: pushTokens.token,
      name: appUsers.name,
      email: appUsers.email,
      subscriptionExpiry: appUsers.subscriptionExpiry,
    })
    .from(appUsers)
    .innerJoin(pushTokens, eq(appUsers.id, pushTokens.userId))
    .where(sql`${appUsers.subscriptionExpiry} IS NOT NULL
      AND ${appUsers.subscriptionExpiry} > ${now}
      AND ${appUsers.subscriptionExpiry} <= ${future}
      AND ${appUsers.subscriptionPlan} != 'free'`);
  return rows.map(r => ({
    userId: r.userId,
    token: r.token,
    name: r.name ?? 'عزيزي المشترك',
    email: r.email,
    subscriptionExpiry: r.subscriptionExpiry!,
  }));
}

/** جلب Push Tokens لجميع المشتركين النشطين (لإرسال إشعارات جماعية) */
export async function getAllSubscriberPushTokens(): Promise<Array<{ userId: number; token: string; name: string }>> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      userId: appUsers.id,
      token: pushTokens.token,
      name: appUsers.name,
    })
    .from(appUsers)
    .innerJoin(pushTokens, eq(appUsers.id, pushTokens.userId))
    .where(sql`${appUsers.subscriptionPlan} != 'free'
      AND ${appUsers.subscriptionExpiry} IS NOT NULL
      AND ${appUsers.subscriptionExpiry} > NOW()`);
  return rows.map(r => ({
    userId: r.userId,
    token: r.token,
    name: r.name ?? 'عزيزي المشترك',
  }));
}

/** جلب Push Tokens للمدراء (isAdmin = '1') */
export async function getAdminPushTokens(): Promise<Array<{ userId: number; token: string; name: string }>> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      userId: appUsers.id,
      token: pushTokens.token,
      name: appUsers.name,
    })
    .from(appUsers)
    .innerJoin(pushTokens, eq(appUsers.id, pushTokens.userId))
    .where(eq(appUsers.isAdmin, '1'));
  return rows.map(r => ({
    userId: r.userId,
    token: r.token,
    name: r.name ?? 'المدير',
  }));
}

/** حذف Push Token لمستخدم */
export async function deletePushToken(userId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
}

// ── Payment History ──────────────────────────────────────────────────────────────
/** حفظ سجل دفعة جديدة */
export async function insertPaymentHistory(data: InsertPaymentHistoryRecord): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const result = await db.insert(paymentHistory).values(data);
  return (result as any).insertId as number;
}

/** جلب سجل دفعات مستخدم محدد (بالـ userId أو بالبريد الإلكتروني) */
export async function getPaymentHistoryByUserId(userId: number, limit = 50): Promise<PaymentHistoryRecord[]> {
  const db = await getDb();
  if (!db) return [];
  // جلب بيانات المستخدم للحصول على بريده الإلكتروني
  const user = await getAppUserById(userId);
  const userEmail = user?.email;
  // جلب السجلات بالـ userId أو بالبريد الإلكتروني (لدعم الطلبات المُرسلة قبل تسجيل الدخول)
  const condition = userEmail
    ? or(eq(paymentHistory.userId, userId), eq(paymentHistory.customerEmail, userEmail))
    : eq(paymentHistory.userId, userId);
  return db.select().from(paymentHistory)
    .where(condition)
    .orderBy(desc(paymentHistory.createdAt))
    .limit(limit);
}

/** حذف سجل دفع بواسطة id */
export async function deletePaymentHistoryById(id: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const result = await db.delete(paymentHistory).where(eq(paymentHistory.id, id));
  const [header] = result as unknown as [{ affectedRows: number }, unknown];
  return (header.affectedRows ?? 0) > 0;
}

/** جلب سجلات الدفع بالبريد الإلكتروني مباشرة، بغض النظر عن userId */
export async function getPaymentHistoryByEmail(email: string, limit = 50): Promise<PaymentHistoryRecord[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(paymentHistory)
    .where(eq(paymentHistory.customerEmail, email.toLowerCase().trim()))
    .orderBy(desc(paymentHistory.createdAt))
    .limit(limit);
}

/** جلب جميع سجلات الدفع (للمدير) */
export async function getAllPaymentHistory(limit = 200): Promise<PaymentHistoryRecord[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(paymentHistory)
    .orderBy(desc(paymentHistory.createdAt))
    .limit(limit);
}

/** جلب طلبات STC Pay المعلّقة (للمدير) */
export async function getPendingStcPayments(limit = 100): Promise<PaymentHistoryRecord[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(paymentHistory)
    .where(and(eq(paymentHistory.gateway, 'stcpay'), eq(paymentHistory.status, 'pending')))
    .orderBy(desc(paymentHistory.createdAt))
    .limit(limit);
}

/** جلب طلبات PayPal المعلّقة */
export async function getPendingPayPalPayments(limit = 100): Promise<PaymentHistoryRecord[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(paymentHistory)
    .where(and(eq(paymentHistory.gateway, 'paypal'), eq(paymentHistory.status, 'pending')))
    .orderBy(desc(paymentHistory.createdAt))
    .limit(limit);
}

/** جلب طلبات Wise المعلّقة */
export async function getPendingWisePayments(limit = 100): Promise<PaymentHistoryRecord[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(paymentHistory)
    .where(and(eq(paymentHistory.gateway, 'wise'), eq(paymentHistory.status, 'pending')))
    .orderBy(desc(paymentHistory.createdAt))
    .limit(limit);
}

/** جلب طلبات IBAN المعلّقة */
export async function getPendingCryptoPayments(limit = 100): Promise<PaymentHistoryRecord[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(paymentHistory)
    .where(and(eq(paymentHistory.gateway, 'crypto'), eq(paymentHistory.status, 'pending')))
    .orderBy(desc(paymentHistory.createdAt))
    .limit(limit);
}

export async function getPendingIbanPayments(limit = 100): Promise<PaymentHistoryRecord[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(paymentHistory)
    .where(and(eq(paymentHistory.gateway, 'iban'), eq(paymentHistory.status, 'pending')))
    .orderBy(desc(paymentHistory.createdAt))
    .limit(limit);
}

/** تحديث حالة سجل دفعة محددة */
export async function updatePaymentHistoryStatus(
  id: number,
  status: 'success' | 'failed' | 'pending' | 'refunded'
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  await db.update(paymentHistory).set({ status }).where(eq(paymentHistory.id, id));
}

/** جلب سجل دفع واحد بالمعرف */
export async function getPaymentHistoryById(id: number): Promise<PaymentHistoryRecord | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(paymentHistory).where(eq(paymentHistory.id, id)).limit(1);
  return rows[0] ?? null;
}

// ── App Installs / First Opens ────────────────────────────────────────────────

/** تسجيل فتح التطبيق — يُنشئ سجلاً جديداً في أول فتح، ويحدّث العداد في كل فتح لاحق */
export async function recordAppInstall(data: InsertAppInstall): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.insert(appInstalls).values(data).onConflictDoUpdate({
      target: appInstalls.deviceId,
      set: {
        lastOpenAt: new Date(),
        openCount: sql`${appInstalls.openCount} + 1`,
        appVersion: data.appVersion ?? null,
      },
    });
  } catch (err) {
    console.warn("[AppInstalls] Failed to record:", err);
  }
}

/** جلب إحصائيات التنزيلات للمدير */
export async function getInstallStats(sinceDate?: Date): Promise<{
  total: number;
  byPlatform: { platform: string; count: number }[];
  byVersion: { version: string; count: number }[];
  byCountry: { country: string; count: number }[];
  recent: AppInstall[];
  dailyCounts: { date: string; count: number }[];
}> {
  const db = await getDb();
  if (!db) return { total: 0, byPlatform: [], byVersion: [], byCountry: [], recent: [], dailyCounts: [] };

  const baseQuery = sinceDate
    ? db.select().from(appInstalls).where(sql`${appInstalls.firstOpenAt} >= ${sinceDate}`)
    : db.select().from(appInstalls);

  const [allInstalls, recent] = await Promise.all([
    baseQuery.orderBy(desc(appInstalls.firstOpenAt)),
    (sinceDate
      ? db.select().from(appInstalls).where(sql`${appInstalls.firstOpenAt} >= ${sinceDate}`)
      : db.select().from(appInstalls)
    ).orderBy(desc(appInstalls.firstOpenAt)).limit(50),
  ]);

  const total = allInstalls.length;

  // تجميع حسب المنصة
  const platformMap: Record<string, number> = {};
  const versionMap: Record<string, number> = {};
  const dayMap: Record<string, number> = {};
  const countryMap: Record<string, number> = {};

  for (const r of allInstalls) {
    const p = r.platform ?? 'unknown';
    platformMap[p] = (platformMap[p] ?? 0) + 1;

    const v = r.appVersion ?? 'unknown';
    versionMap[v] = (versionMap[v] ?? 0) + 1;

    const d = r.firstOpenAt.toISOString().slice(0, 10);
    dayMap[d] = (dayMap[d] ?? 0) + 1;

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

import { integer, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
export const users = pgTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: serial("id").primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: text("role").notNull().default("user"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// App users table (email/password auth)
export const appUsers = pgTable("app_users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  password: varchar("password", { length: 255 }).notNull(),
  isAdmin: text("isAdmin").notNull().default("0"),
  subscriptionPlan: varchar("subscriptionPlan", { length: 32 }).default("free").notNull(),
  subscriptionExpiry: timestamp("subscriptionExpiry"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export type AppUser = typeof appUsers.$inferSelect;
export type InsertAppUser = typeof appUsers.$inferInsert;

// ── Discount Codes ────────────────────────────────────────────────────────────
export const discountCodes = pgTable("discount_codes", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  discountPercent: integer("discountPercent").notNull(),
  maxUses: integer("maxUses"),
  usedCount: integer("usedCount").default(0).notNull(),
  isActive: text("isActive").notNull().default("1"),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type DiscountCode = typeof discountCodes.$inferSelect;
export type InsertDiscountCode = typeof discountCodes.$inferInsert;

// ── Payment Events (Webhook log) ──────────────────────────────────────────────
export const paymentEvents = pgTable("payment_events", {
  id: serial("id").primaryKey(),
  gateway: varchar("gateway", { length: 32 }).notNull(),        // 'tap' | 'paddle'
  eventType: varchar("eventType", { length: 64 }).notNull(),    // e.g. 'CAPTURED', 'transaction.completed'
  chargeId: varchar("chargeId", { length: 128 }).notNull(),     // charge/transaction ID from gateway
  orderId: varchar("orderId", { length: 128 }),                  // our internal order ID
  customerEmail: varchar("customerEmail", { length: 320 }),
  amount: integer("amount"),                                         // in smallest currency unit
  currency: varchar("currency", { length: 8 }),
  plan: varchar("plan", { length: 32 }),                         // 'monthly' | 'yearly'
  userId: integer("userId"),                                         // appUsers.id if matched
  status: varchar("status", { length: 32 }).notNull(),          // 'processed' | 'skipped' | 'error'
  errorMessage: text("errorMessage"),
  rawPayload: text("rawPayload"),                                // JSON string of full webhook body
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type InsertPaymentEvent = typeof paymentEvents.$inferInsert;

// ── Push Notification Tokens ────────────────────────────────────────────────────────────
export const pushTokens = pgTable("push_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull(),              // appUsers.id
  token: varchar("token", { length: 512 }).notNull().unique(), // Expo push token
  platform: varchar("platform", { length: 16 }), // 'ios' | 'android'
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});
export type PushToken = typeof pushTokens.$inferSelect;
export type InsertPushToken = typeof pushTokens.$inferInsert;

// ── Payment History (per-user transaction log) ────────────────────────────────
export const paymentHistory = pgTable("payment_history", {
  id: serial("id").primaryKey(),
  userId: integer("userId"),                                      // appUsers.id (nullable for guest payments)
  customerEmail: varchar("customerEmail", { length: 255 }),    // email fallback when userId is null
  gateway: varchar("gateway", { length: 32 }).notNull(),        // 'tap' | 'paddle' | 'paypal' | 'stcpay'
  chargeId: varchar("chargeId", { length: 128 }),               // gateway charge/transaction ID
  amount: integer("amount").notNull(),                              // in halalas (SAR * 100)
  currency: varchar("currency", { length: 8 }).default("SAR").notNull(),
  plan: varchar("plan", { length: 32 }),                        // 'monthly' | 'yearly'
  status: text("status").notNull(),
  cardLast4: varchar("cardLast4", { length: 4 }),               // last 4 digits of card
  cardBrand: varchar("cardBrand", { length: 16 }),              // 'visa' | 'mastercard' | 'amex' | 'mada'
  referenceId: varchar("referenceId", { length: 128 }),         // our internal reference
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PaymentHistoryRecord = typeof paymentHistory.$inferSelect;
export type InsertPaymentHistoryRecord = typeof paymentHistory.$inferInsert;

// ── App Installs / First Opens ────────────────────────────────────────────────
export const appInstalls = pgTable("app_installs", {
  id: serial("id").primaryKey(),
  deviceId: varchar("deviceId", { length: 128 }).notNull().unique(), // معرّف الجهاز الفريد
  appVersion: varchar("appVersion", { length: 32 }),                  // رقم الإصدار عند أول فتح
  platform: varchar("platform", { length: 16 }),                      // 'android' | 'ios'
  deviceModel: varchar("deviceModel", { length: 64 }),                // موديل الجهاز
  country: varchar("country", { length: 8 }),                         // رمز الدولة (اختياري)
  firstOpenAt: timestamp("firstOpenAt").defaultNow().notNull(),        // وقت أول فتح
  lastOpenAt: timestamp("lastOpenAt").defaultNow().notNull(), // آخر فتح
  openCount: integer("openCount").default(1).notNull(),                   // عدد مرات الفتح
});
export type AppInstall = typeof appInstalls.$inferSelect;
export type InsertAppInstall = typeof appInstalls.$inferInsert;



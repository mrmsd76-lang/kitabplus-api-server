/**
 * webhook.ts — معالج Webhooks لـ Tap Payments و Paddle
 *
 * نقاط الدخول:
 *   POST /api/webhooks/tap    ← Tap Payments
 *   POST /api/webhooks/paddle ← Paddle
 *
 * الأمان:
 *   - Tap:    HMAC-SHA256 على الـ raw body مقارنةً بـ TAP_WEBHOOK_SECRET
 *   - Paddle: HMAC-SHA256 على الـ raw body مقارنةً بـ PADDLE_WEBHOOK_SECRET
 *
 * عند نجاح التحقق:
 *   1. تسجيل الحدث في جدول payment_events
 *   2. البحث عن المستخدم بالبريد الإلكتروني
 *   3. تفعيل/تجديد الاشتراك في appUsers
 */

import crypto from "crypto";
import type { Express, Request, Response } from "express";
import * as db from "./db";
import { calcSubscriptionExpiry } from "./payment";
import { sendEmail } from "./_core/email";
import { buildSubscriptionConfirmEmailHtml } from "./_core/email-subscription";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * مقارنة آمنة ضد timing attacks
 */
function safeEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * حساب HMAC-SHA256 وإرجاع hex
 */
function hmacSha256(secret: string, data: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

/**
 * تحديد خطة الاشتراك من الوصف أو البيانات المخصصة
 */
function detectPlan(
  description?: string,
  customData?: Record<string, unknown>
): "monthly" | "yearly" {
  const text = [
    description ?? "",
    JSON.stringify(customData ?? {}),
  ]
    .join(" ")
    .toLowerCase();

  if (text.includes("yearly") || text.includes("سنوي") || text.includes("annual")) {
    return "yearly";
  }
  return "monthly";
}

// ── Tap Payments Webhook ──────────────────────────────────────────────────────

/**
 * التحقق من توقيع Tap Payments
 * Tap يُرسل الـ signature في header: hashstring
 * الـ signature = HMAC-SHA256(secret, rawBody)
 */
function verifyTapSignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env.TAP_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[webhook/tap] TAP_WEBHOOK_SECRET غير مُعيَّن — تخطّي التحقق في وضع الاختبار");
    return true; // في وضع الاختبار بدون مفتاح نقبل الطلب
  }
  const expected = hmacSha256(secret, rawBody.toString("utf8"));
  return safeEqual(expected, signature.toLowerCase());
}

async function handleTapWebhook(req: Request, res: Response): Promise<void> {
  const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
  const signature = (req.headers["hashstring"] as string) ?? "";

  // التحقق من التوقيع
  if (signature && !verifyTapSignature(rawBody, signature)) {
    console.warn("[webhook/tap] توقيع غير صالح");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const payload = req.body as Record<string, unknown>;
  const status = payload?.status as string | undefined;
  const chargeId = (payload?.id as string) ?? "";
  const orderId = (payload?.reference as Record<string, unknown>)?.order as string | undefined;
  const customer = payload?.customer as Record<string, unknown> | undefined;
  const customerEmail = customer?.email as string | undefined;
  const amountRaw = payload?.amount as number | undefined;
  const currency = payload?.currency as string | undefined;
  const description = payload?.description as string | undefined;

  // نقبل فقط الحالة CAPTURED (دفع ناجح)
  if (status !== "CAPTURED") {
    console.log(`[webhook/tap] تجاهل حدث بحالة: ${status}`);
    res.json({ received: true, action: "skipped", reason: `status=${status}` });
    return;
  }

  const plan = detectPlan(description);
  let userId: number | undefined;
  let processStatus: "processed" | "skipped" | "error" = "processed";
  let errorMessage: string | undefined;

  try {
    // البحث عن المستخدم وتفعيل الاشتراك
    if (customerEmail) {
      const user = await db.getAppUserByEmail(customerEmail);
      if (user) {
        userId = user.id;
        const expiry = calcSubscriptionExpiry(plan);
        await db.updateAppUserSubscription(user.id, plan, expiry);
        console.log(`[webhook/tap] ✅ تم تفعيل اشتراك ${plan} للمستخدم ${user.id} (${customerEmail})`);
        // إرسال بريد تأكيد الاشتراك
        sendEmail({
          to: customerEmail,
          subject: 'تم تفعيل اشتراكك — كتاب+',
          html: buildSubscriptionConfirmEmailHtml(user.name, plan, expiry),
        }).catch(err => console.warn('[webhook/tap] فشل إرسال بريد التأكيد:', err));
      } else {
        processStatus = "skipped";
        errorMessage = `لم يُعثر على مستخدم بالبريد: ${customerEmail}`;
        console.warn(`[webhook/tap] ⚠️ ${errorMessage}`);
      }
    } else {
      processStatus = "skipped";
      errorMessage = "البريد الإلكتروني غير موجود في الـ payload";
      console.warn(`[webhook/tap] ⚠️ ${errorMessage}`);
    }
  } catch (err) {
    processStatus = "error";
    errorMessage = err instanceof Error ? err.message : "خطأ غير معروف";
    console.error(`[webhook/tap] ❌ ${errorMessage}`);
  }

  // تسجيل الحدث في قاعدة البيانات
  try {
    await db.insertPaymentEvent({
      gateway: "tap",
      eventType: "CAPTURED",
      chargeId,
      orderId: orderId ?? null,
      customerEmail: customerEmail ?? null,
      amount: amountRaw ? Math.round(amountRaw * 100) : null,
      currency: currency ?? null,
      plan,
      userId: userId ?? null,
      status: processStatus,
      errorMessage: errorMessage ?? null,
      rawPayload: JSON.stringify(payload),
    });
  } catch (dbErr) {
    console.error("[webhook/tap] فشل تسجيل الحدث في DB:", dbErr);
  }

  res.json({ received: true, action: processStatus });
}

// ── Paddle Webhook ────────────────────────────────────────────────────────────

/**
 * التحقق من توقيع Paddle
 * Paddle يُرسل: Paddle-Signature: ts=TIMESTAMP;h1=HMAC_HEX
 * الـ signature = HMAC-SHA256(secret, ts + ":" + rawBody)
 */
function verifyPaddleSignature(rawBody: Buffer, signatureHeader: string): boolean {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[webhook/paddle] PADDLE_WEBHOOK_SECRET غير مُعيَّن — تخطّي التحقق في وضع الاختبار");
    return true;
  }

  // تحليل الـ header: ts=1234567890;h1=abc123...
  const parts: Record<string, string> = {};
  for (const part of signatureHeader.split(";")) {
    const [key, val] = part.split("=");
    if (key && val) parts[key.trim()] = val.trim();
  }

  const ts = parts["ts"];
  const h1 = parts["h1"];
  if (!ts || !h1) return false;

  const signedPayload = `${ts}:${rawBody.toString("utf8")}`;
  const expected = hmacSha256(secret, signedPayload);
  return safeEqual(expected, h1.toLowerCase());
}

async function handlePaddleWebhook(req: Request, res: Response): Promise<void> {
  const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
  const signatureHeader = (req.headers["paddle-signature"] as string) ?? "";

  // التحقق من التوقيع
  if (signatureHeader && !verifyPaddleSignature(rawBody, signatureHeader)) {
    console.warn("[webhook/paddle] توقيع غير صالح");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const payload = req.body as Record<string, unknown>;
  const eventType = payload?.event_type as string | undefined;
  const data = payload?.data as Record<string, unknown> | undefined;

  // نقبل فقط transaction.completed
  if (eventType !== "transaction.completed") {
    console.log(`[webhook/paddle] تجاهل حدث: ${eventType}`);
    res.json({ received: true, action: "skipped", reason: `event_type=${eventType}` });
    return;
  }

  const chargeId = (data?.id as string) ?? "";
  const customData = data?.custom_data as Record<string, unknown> | undefined;
  const orderId = customData?.orderId as string | undefined;
  const customerData = data?.customer as Record<string, unknown> | undefined;
  const customerEmail = customerData?.email as string | undefined;
  const details = data?.details as Record<string, unknown> | undefined;
  const totals = details?.totals as Record<string, unknown> | undefined;
  const amountRaw = totals?.total as string | undefined;
  const currency = data?.currency_code as string | undefined;

  const plan = detectPlan(undefined, customData);
  let userId: number | undefined;
  let processStatus: "processed" | "skipped" | "error" = "processed";
  let errorMessage: string | undefined;

  try {
    if (customerEmail) {
      const user = await db.getAppUserByEmail(customerEmail);
      if (user) {
        userId = user.id;
        const expiry = calcSubscriptionExpiry(plan);
        await db.updateAppUserSubscription(user.id, plan, expiry);
        console.log(`[webhook/paddle] ✅ تم تفعيل اشتراك ${plan} للمستخدم ${user.id} (${customerEmail})`);
        // إرسال بريد تأكيد الاشتراك
        sendEmail({
          to: customerEmail,
          subject: 'تم تفعيل اشتراكك — كتاب+',
          html: buildSubscriptionConfirmEmailHtml(user.name, plan, expiry),
        }).catch(err => console.warn('[webhook/paddle] فشل إرسال بريد التأكيد:', err));
      } else {
        processStatus = "skipped";
        errorMessage = `لم يُعثر على مستخدم بالبريد: ${customerEmail}`;
        console.warn(`[webhook/paddle] ⚠️ ${errorMessage}`);
      }
    } else {
      processStatus = "skipped";
      errorMessage = "البريد الإلكتروني غير موجود في الـ payload";
      console.warn(`[webhook/paddle] ⚠️ ${errorMessage}`);
    }
  } catch (err) {
    processStatus = "error";
    errorMessage = err instanceof Error ? err.message : "خطأ غير معروف";
    console.error(`[webhook/paddle] ❌ ${errorMessage}`);
  }

  // تسجيل الحدث
  try {
    await db.insertPaymentEvent({
      gateway: "paddle",
      eventType: eventType ?? "transaction.completed",
      chargeId,
      orderId: orderId ?? null,
      customerEmail: customerEmail ?? null,
      amount: amountRaw ? parseInt(amountRaw, 10) : null,
      currency: currency ?? null,
      plan,
      userId: userId ?? null,
      status: processStatus,
      errorMessage: errorMessage ?? null,
      rawPayload: JSON.stringify(payload),
    });
  } catch (dbErr) {
    console.error("[webhook/paddle] فشل تسجيل الحدث في DB:", dbErr);
  }

  res.json({ received: true, action: processStatus });
}

// ── Register Routes ───────────────────────────────────────────────────────────

/**
 * تسجيل نقاط دخول Webhooks في Express
 * يجب استدعاء هذه الدالة قبل express.json() middleware
 * لأننا نحتاج الـ raw body للتحقق من التوقيع
 */
export function registerWebhookRoutes(app: Express): void {
  // Middleware لحفظ الـ raw body قبل parse
  app.use(
    ["/api/webhooks/tap", "/api/webhooks/paddle"],
    (req: Request, _res, next) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
        // Parse JSON يدوياً بعد حفظ الـ raw body
        try {
          req.body = JSON.parse((req as Request & { rawBody?: Buffer }).rawBody!.toString("utf8"));
        } catch {
          req.body = {};
        }
        next();
      });
    }
  );

  // Tap Payments Webhook
  app.post("/api/webhooks/tap", (req: Request, res: Response) => {
    handleTapWebhook(req, res).catch((err) => {
      console.error("[webhook/tap] unhandled error:", err);
      res.status(500).json({ error: "Internal server error" });
    });
  });

  // Paddle Webhook
  app.post("/api/webhooks/paddle", (req: Request, res: Response) => {
    handlePaddleWebhook(req, res).catch((err) => {
      console.error("[webhook/paddle] unhandled error:", err);
      res.status(500).json({ error: "Internal server error" });
    });
  });

  // نقطة فحص صحة Webhooks
  app.get("/api/webhooks/status", (_req: Request, res: Response) => {
    res.json({
      tap: {
        endpoint: "/api/webhooks/tap",
        secretConfigured: !!process.env.TAP_WEBHOOK_SECRET,
        mode: process.env.TAP_WEBHOOK_SECRET?.startsWith("test_") ? "test" : "live",
      },
      paddle: {
        endpoint: "/api/webhooks/paddle",
        secretConfigured: !!process.env.PADDLE_WEBHOOK_SECRET,
        mode: process.env.PADDLE_WEBHOOK_SECRET?.startsWith("test_") ? "test" : "live",
      },
    });
  });

  console.log("[webhook] ✅ Webhook routes registered:");
  console.log("  POST /api/webhooks/tap");
  console.log("  POST /api/webhooks/paddle");
  console.log("  GET  /api/webhooks/status");
}

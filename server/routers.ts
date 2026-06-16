import { z } from "zod";
import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { sendEmail, buildPasswordResetEmailHtml, buildSubscriptionConfirmEmailHtml, buildRenewalReminderEmailHtml, buildPaymentReceiptEmailHtml, buildWelcomeEmailHtml } from "./_core/email";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, adminProcedure, router } from "./_core/trpc";
import { sdk } from "./_core/sdk";
import * as db from "./db";
import { createCharge, verifyPayment, calcSubscriptionExpiry, type PaymentGateway } from "./payment";
import * as sbData from "./supabase-data";
import { sendRenewalPushNotification, sendNewBookPushNotification, sendBookSuggestionStatusPushNotification, sendCommentDeletedPushNotification, sendSubscriptionActivatedPushNotification, sendSubscriptionUpdatedPushNotification, sendAdminNewPaymentPushNotification, sendVIPChannelWelcomeNotification } from "./push-notifications";

// ── In-memory password reset codes store (email → {code, expiry}) ─────────────
// In production: replace with Redis or a DB table for persistence
const passwordResetCodes = new Map<string, { code: string; expiry: number }>();

// ── Simple password hashing (SHA-256 via Web Crypto / Node crypto) ────────────
async function hashPassword(password: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(password).digest("hex");
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ── App Auth (email + password) ─────────────────────────────────────────────
  appAuth: router({
    /**
     * تسجيل مستخدم جديد
     */
    register: publicProcedure
      .input(
        z.object({
          name: z.string().min(2).max(255),
          email: z.string().email().max(320),
          password: z.string().min(6).max(255),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const email = input.email.trim().toLowerCase();

        // تحقق من عدم تكرار البريد
        const existing = await db.getAppUserByEmail(email);
        if (existing) {
          return { success: false, error: "هذا البريد الإلكتروني مسجل بالفعل، يرجى تسجيل الدخول" };
        }

        const hashedPassword = await hashPassword(input.password);

        const id = await db.createAppUser({
          name: input.name.trim(),
          email,
          password: hashedPassword,
        });

        const user = await db.getAppUserById(id);
        if (!user) return { success: false, error: "حدث خطأ أثناء إنشاء الحساب" };

        // Create session for the new user
        const openId = `appuser_${user.id}`;
        await db.upsertUser({
          openId,
          name: user.name,
          email: user.email,
          loginMethod: 'email',
          lastSignedIn: new Date(),
          role: user.isAdmin === '1' ? 'admin' : 'user',
        });
        const sessionToken = await sdk.createSessionToken(openId, { name: user.name });
        // Set cookie for web platform
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: 365 * 24 * 60 * 60 * 1000 });

        // إرسال بريد ترحيب للمستخدم الجديد (بشكل غير متزامن لعدم تأخير الاستجابة)
        sendEmail({
          to: email,
          subject: '🎉 مرحباً بك في كتاب+!',
          html: buildWelcomeEmailHtml(input.name.trim()),
        }).then(result => {
          if (result.success) {
            console.log(`[Welcome] Email sent to ${email} (id: ${result.id})`);
          } else {
            console.warn(`[Welcome] Email failed for ${email}: ${result.error}`);
          }
        }).catch(err => console.warn('[Welcome] Email error:', err));

        return {
          success: true,
          sessionToken,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            isAdmin: user.isAdmin === "1",
            subscriptionPlan: user.subscriptionPlan,
            subscriptionExpiry: user.subscriptionExpiry?.toISOString() ?? null,
          },
        };
      }),

    /**
     * تسجيل الدخول
     */
    login: publicProcedure
      .input(
        z.object({
          email: z.string().email(),
          password: z.string().min(1),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const email = input.email.trim().toLowerCase();
        const hashedPassword = await hashPassword(input.password);

        const user = await db.getAppUserByEmail(email);
        if (!user || user.password !== hashedPassword) {
          return { success: false, error: "البريد الإلكتروني أو كلمة المرور غير صحيحة" };
        }

        // إنشاء openId فريد من نوع appUser وربطه بجدول users
        const openId = `appuser_${user.id}`;
        await db.upsertUser({
          openId,
          name: user.name,
          email: user.email,
          loginMethod: 'email',
          lastSignedIn: new Date(),
          role: user.isAdmin === '1' ? 'admin' : 'user',
        });
        const sessionToken = await sdk.createSessionToken(openId, { name: user.name });
        // Set cookie for web platform (so subsequent requests are authenticated)
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: 365 * 24 * 60 * 60 * 1000 });
        return {
          success: true,
          sessionToken,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            isAdmin: user.isAdmin === "1",
            subscriptionPlan: user.subscriptionPlan,
            subscriptionExpiry: user.subscriptionExpiry?.toISOString() ?? null,
          },
        };
      }),

    /**
     * طلب إعادة تعيين كلمة المرور — يُنشئ رمزاً مؤقتاً صالحاً لـ 15 دقيقة
     * ملاحظة: في بيئة الإنتاج يُرسل الرمز عبر البريد الإلكتروني.
     * هنا نُعيده مباشرة للاختبار (يمكن ربطه بـ SMTP لاحقاً).
     */
    requestPasswordReset: publicProcedure
      .input(z.object({ email: z.string().email() }))
      .mutation(async ({ input }) => {
        const email = input.email.trim().toLowerCase();
        const user = await db.getAppUserByEmail(email);
        // لا نكشف إن كان البريد مسجلاً أم لا (أمان)
        if (!user) {
          return { success: true, message: 'إذا كان البريد مسجلاً، ستصلك تعليمات الاستعادة' };
        }
        // توليد رمز 6 أرقام صالح لـ 15 دقيقة
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiry = Date.now() + 15 * 60 * 1000;
        // حفظ الرمز مؤقتاً في الذاكرة (في الإنتاج: استخدم Redis أو جدول DB)
        passwordResetCodes.set(email, { code, expiry });
        // إرسال الرمز عبر Resend API
        const emailResult = await sendEmail({
          to: email,
          subject: '🔐 رمز استعادة كلمة المرور — كتاب+',
          html: buildPasswordResetEmailHtml(code),
        });
        if (!emailResult.success) {
          console.warn(`[PasswordReset] Email send failed for ${email}: ${emailResult.error}`);
          // في حالة فشل الإرسال، نُعيد الرمز في وضع التطوير فقط
          return {
            success: true,
            message: 'تم إنشاء رمز التحقق. يرجى التحقق من بريدك الإلكتروني أو السجلات في وضع التطوير.',
            devCode: process.env.NODE_ENV !== 'production' ? code : undefined,
          };
        }
        console.log(`[PasswordReset] Email sent to ${email} (id: ${emailResult.id})`);
        return { success: true, message: 'تم إرسال رمز التحقق إلى بريدك الإلكتروني' };
      }),

    /**
     * التحقق من رمز إعادة التعيين وتحديث كلمة المرور
     */
    resetPassword: publicProcedure
      .input(z.object({
        email: z.string().email(),
        code: z.string().length(6),
        newPassword: z.string().min(6).max(255),
      }))
      .mutation(async ({ input, ctx }) => {
        const email = input.email.trim().toLowerCase();
        const stored = passwordResetCodes.get(email);
        if (!stored) {
          return { success: false, error: 'لم يتم طلب استعادة كلمة المرور لهذا البريد' };
        }
        if (Date.now() > stored.expiry) {
          passwordResetCodes.delete(email);
          return { success: false, error: 'انتهت صلاحية رمز التحقق، يرجى طلب رمز جديد' };
        }
        if (stored.code !== input.code.trim()) {
          return { success: false, error: 'رمز التحقق غير صحيح' };
        }
        const user = await db.getAppUserByEmail(email);
        if (!user) {
          return { success: false, error: 'البريد الإلكتروني غير مسجل' };
        }
        const hashedPassword = await hashPassword(input.newPassword);
        await db.updateAppUserPassword(user.id, hashedPassword);
        passwordResetCodes.delete(email);
        // إصلاح (2): إصدار token جديد بعد تغيير كلمة المرور — يُبطل الجلسات القديمة تلقائياً
        const resetOpenId = `appuser_${user.id}`;
        await db.upsertUser({
          openId: resetOpenId,
          name: user.name,
          email: user.email,
          loginMethod: 'email',
          lastSignedIn: new Date(),
          role: user.isAdmin === '1' ? 'admin' : 'user',
        });
        const newSessionToken = await sdk.createSessionToken(resetOpenId, { name: user.name });
        // Set cookie for web platform
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, newSessionToken, { ...cookieOptions, maxAge: 365 * 24 * 60 * 60 * 1000 });
        return { success: true, message: 'تم تحديث كلمة المرور بنجاح', sessionToken: newSessionToken };
      }),

    /**
     * تسجيل الدخول / التسجيل عبر OAuth (Google / Apple)
     * إذا كان البريد موجوداً → تسجيل دخول مباشر
     * إذا كان جديداً → إنشاء حساب تلقائي بدون كلمة مرور
     */
    oauthLogin: publicProcedure
      .input(
        z.object({
          provider: z.enum(['google', 'apple']),
          name: z.string().min(1).max(255),
          email: z.string().email().max(320),
          avatarUrl: z.string().optional(),
        })
      )
          .mutation(async ({ input, ctx }) => {
        const email = input.email.trim().toLowerCase();
        const name = input.name.trim();
        // تحقق من وجود المستخدم
        let user = await db.getAppUserByEmail(email);
        if (!user) {
          // مستخدم جديد — إنشاء حساب تلقائي بدون كلمة مرور
          const id = await db.createAppUser({
            name,
            email,
            password: '', // لا كلمة مرور لحسابات OAuth
          });
          user = await db.getAppUserById(id);
          if (!user) return { success: false, error: 'حث خطأ أثناء إنشاء الحساب' };
          // إرسال بريد ترحيب
          sendEmail({
            to: email,
            subject: '🎉 مرحباً بك في كتاب+!',
            html: buildWelcomeEmailHtml(name),
          }).catch(err => console.warn('[OAuth Welcome] Email error:', err));
        }
        // إنشاء openId وربطه بجدول users لإصدار session token
        const oauthOpenId = `appuser_${user.id}`;
        await db.upsertUser({
          openId: oauthOpenId,
          name: user.name,
          email: user.email,
          loginMethod: input.provider,
          lastSignedIn: new Date(),
          role: user.isAdmin === '1' ? 'admin' : 'user',
        });
        const oauthSessionToken = await sdk.createSessionToken(oauthOpenId, { name: user.name });
        // Set cookie for web platform
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, oauthSessionToken, { ...cookieOptions, maxAge: 365 * 24 * 60 * 60 * 1000 });
        return {
          success: true,
          sessionToken: oauthSessionToken,
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            isAdmin: user.isAdmin === '1',
            subscriptionPlan: user.subscriptionPlan,
            subscriptionExpiry: user.subscriptionExpiry?.toISOString() ?? null,
          },
        };
      }),

    /**
     * تجديد session token — يُصدر token جديداً للمستخدم المسجّل (إصلاح 1)
     */
    refreshToken: publicProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const user = await db.getAppUserById(input.userId);
        if (!user) return { success: false, error: 'المستخدم غير موجود' };
        const openId = `appuser_${user.id}`;
        await db.upsertUser({
          openId,
          name: user.name,
          email: user.email,
          loginMethod: 'email',
          lastSignedIn: new Date(),
          role: user.isAdmin === '1' ? 'admin' : 'user',
        });
        const sessionToken = await sdk.createSessionToken(openId, { name: user.name });
        // Set cookie for web platform
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: 365 * 24 * 60 * 60 * 1000 });
        return { success: true, sessionToken };
      }),

    /**
     * جلب بيانات مستخدم بالـ id
     */
    getUser: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const user = await db.getAppUserById(input.id);
        if (!user) return null;
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          isAdmin: user.isAdmin === "1",
          subscriptionPlan: user.subscriptionPlan,
          subscriptionExpiry: user.subscriptionExpiry?.toISOString() ?? null,
        };
      }),

    /**
     * تفعيل الاشتراك التجريبي (24 ساعة) — مرة واحدة فقط لكل مستخدم
     * لا يحتاج إلى موافقة المدير
     */
    activateTrial: publicProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input }) => {
        const user = await db.getAppUserById(input.userId);
        if (!user) {
          return { success: false, error: 'المستخدم غير موجود' };
        }
        // التحقق من أن المستخدم لم يستخدم التجربة مسبقاً
        const history = await db.getPaymentHistoryByUserId(input.userId, 100);
        const alreadyUsedTrial = history.some(h => h.plan === 'trial');
        if (alreadyUsedTrial) {
          return { success: false, error: 'لقد استخدمت الخطة التجريبية مسبقاً. يمكنك الاشتراك في الخطة السنوية.' };
        }
        // حساب انتهاء التجربة (24 ساعة)
        const expiry = calcSubscriptionExpiry('trial');
        // تحديث الاشتراك في قاعدة البيانات
        await db.updateAppUserSubscription(input.userId, 'trial', expiry);
        // تسجيل في سجل الدفع لمنع التكرار
        try {
          await db.insertPaymentHistory({
            userId: input.userId,
            customerEmail: user.email ?? null,
            gateway: 'free',
            chargeId: `trial_${Date.now()}`,
            amount: 0,
            currency: 'USD',
            plan: 'trial',
            status: 'success',
            referenceId: `trial_${input.userId}_${Date.now()}`,
          });
        } catch { /* non-critical */ }
        // إرسال بريد تأكيد
        if (user.email) {
          sendEmail({
            to: user.email,
            subject: 'تم تفعيل تجربتك المجانية — كتاب+',
            html: buildSubscriptionConfirmEmailHtml(user.name, 'trial', expiry),
          }).catch(() => {});
        }
        return {
          success: true,
          subscriptionPlan: 'trial',
          subscriptionExpiry: expiry.toISOString(),
        };
      }),
  }),

  // ── Payment ───────────────────────────────────────────────────────────────────
  payment: router({
    /**
     * إنشاء عملية دفع عبر Tap Payments أو Paddle
     */
    createCharge: publicProcedure
      .input(
        z.object({
          gateway: z.enum(['tap', 'paddle', 'paypal', 'stcpay']),
          plan: z.enum(['monthly', 'yearly']),
          currency: z.string().default('SAR'),
          customerName: z.string().min(2).max(255),
          customerEmail: z.string().email(),
          customerPhone: z.string().optional(),
          discountPercent: z.number().min(0).max(100).default(0),
          codeId: z.number().optional(),
          redirectUrl: z.string().url().optional(),
        })
      )
      .mutation(async ({ input }) => {
        // حساب السعر النهائي
        const basePrice = input.plan === 'monthly' ? 29 : 199;
        const finalAmount = input.discountPercent > 0
          ? Math.round(basePrice * (1 - input.discountPercent / 100))
          : basePrice;

        const orderId = `KP-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
        const description = input.plan === 'monthly'
          ? 'اشتراك كتاب+ الشهري'
          : 'اشتراك كتاب+ السنوي';

        const redirectUrl = input.redirectUrl
          ?? `${process.env.APP_BASE_URL ?? 'https://kitabplus.app'}/payment-callback`;

        const result = await createCharge({
          gateway: input.gateway as PaymentGateway,
          amount: finalAmount,
          currency: input.currency,
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          customerPhone: input.customerPhone,
          description,
          orderId,
          redirectUrl,
        });

        return {
          ...result,
          orderId,
          amount: finalAmount,
          currency: input.currency,
          plan: input.plan,
          discountPercent: input.discountPercent,
          codeId: input.codeId,
        };
      }),

    /**
     * دفع مباشر بالبطاقة (Card Token) — بدون تحويل لصفحة خارجية
     * يستخدم Tap Payments Token API
     */
    chargeWithCard: publicProcedure
      .input(
        z.object({
          cardToken: z.string().min(3),
          plan: z.enum(['monthly', 'yearly']),
          currency: z.string().default('SAR'),
          customerName: z.string().min(2).max(255),
          customerEmail: z.string().email(),
          customerPhone: z.string().optional(),
          discountPercent: z.number().min(0).max(100).default(0),
          codeId: z.number().optional(),
          userId: z.number().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const basePrice = input.plan === 'monthly' ? 29 : 199;
        const finalAmount = input.discountPercent > 0
          ? Math.round(basePrice * (1 - input.discountPercent / 100))
          : basePrice;
        const orderId = `KP-CARD-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
        const description = input.plan === 'monthly'
          ? 'اشتراك كتاب+ الشهري'
          : 'اشتراك كتاب+ السنوي';

        const result = await createCharge({
          gateway: 'tap',
          amount: finalAmount,
          currency: input.currency,
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          customerPhone: input.customerPhone,
          description,
          orderId,
          redirectUrl: `${process.env.APP_BASE_URL ?? 'https://kitabplus.app'}/payment-callback`,
          cardToken: input.cardToken,
        });

        if (!result.success) {
          // حفظ سجل الدفع الفاشل
          if (input.userId) {
            try {
              await db.insertPaymentHistory({
                userId: input.userId,
                gateway: 'tap',
                chargeId: result.chargeId ?? null,
                amount: finalAmount * 100,
                currency: input.currency,
                plan: input.plan,
                status: 'failed',
                referenceId: orderId,
                errorMessage: result.error ?? 'فشل الدفع بالبطاقة',
              });
            } catch { /* non-critical */ }
          }
          return { success: false, error: result.error ?? 'فشل الدفع بالبطاقة' };
        }

        // إذا كان الدفع مباشراً (CAPTURED) — فعّل الاشتراك فوراً
        if (result.status === 'CAPTURED' && input.userId) {
          const expiry = calcSubscriptionExpiry(input.plan);
          await db.updateAppUserSubscription(input.userId, input.plan, expiry);
          if (input.codeId) {
            try { await db.incrementDiscountCodeUsage(input.codeId); } catch { /* non-critical */ }
          }
          // حفظ سجل الدفع الناجح
          try {
            await db.insertPaymentHistory({
              userId: input.userId,
              gateway: 'tap',
              chargeId: result.chargeId ?? null,
              amount: finalAmount * 100,
              currency: input.currency,
              plan: input.plan,
              status: 'success',
              referenceId: orderId,
            });
          } catch { /* non-critical */ }

          // إرسال بريد إيصال الدفع للمستخدم
          try {
            const receiptHtml = buildPaymentReceiptEmailHtml({
              userName: input.customerName,
              plan: input.plan,
              amount: finalAmount,
              currency: input.currency,
              chargeId: result.chargeId ?? null,
              referenceId: orderId,
              cardBrand: result.cardBrand ?? null,
              cardLast4: result.cardLast4 ?? null,
              expiry,
            });
            const planLabel = input.plan === 'monthly' ? 'الشهري' : 'السنوي';
            await sendEmail({
              to: input.customerEmail,
              subject: `✅ تم تفعيل اشتراكك ${planLabel} في كتاب+`,
              html: receiptHtml,
            });
            console.log(`[Payment] Receipt email sent to ${input.customerEmail}`);
          } catch (emailErr) {
            // لا نوقف العملية إذا فشل إرسال البريد
            console.warn('[Payment] Failed to send receipt email:', emailErr);
          }

          // إرسال Push Notification لتأكيد تفعيل الاشتراك
          try {
            const pushToken = await db.getPushTokenByUserId(input.userId);
            if (pushToken) {
              const planLabel = input.plan === 'monthly' ? 'الشهري (29 ر.س)' : 'السنوي (199 ر.س)';
              const expiryStr = expiry.toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' });
              await sendSubscriptionActivatedPushNotification(
                pushToken.token,
                input.customerName,
                planLabel,
                expiryStr
              );
              // إشعار ترحيبي للانضمام إلى قناة VIP
              await sendVIPChannelWelcomeNotification(pushToken.token, input.customerName).catch(() => {});
              console.log(`[Payment] Push notification sent to userId=${input.userId}`);
            }
          } catch (pushErr) {
            console.warn('[Payment] Failed to send push notification:', pushErr);
          }

          return {
            success: true,
            activated: true,
            chargeId: result.chargeId,
            plan: input.plan,
            expiry: expiry.toISOString(),
            amount: finalAmount,
            currency: input.currency,
          };
        }

        // إذا احتاج 3DS — حفظ سجل معلّق وأعد paymentUrl
        if (input.userId) {
          try {
            await db.insertPaymentHistory({
              userId: input.userId,
              gateway: 'tap',
              chargeId: result.chargeId ?? null,
              amount: finalAmount * 100,
              currency: input.currency,
              plan: input.plan,
              status: 'pending',
              referenceId: orderId,
            });
          } catch { /* non-critical */ }
        }
        return {
          success: true,
          activated: false,
          chargeId: result.chargeId,
          paymentUrl: result.paymentUrl,
          plan: input.plan,
          amount: finalAmount,
          currency: input.currency,
          codeId: input.codeId,
        };
      }),

    /**
     * جلب سجل دفعات المستخدم
     */
    getHistory: publicProcedure
      .input(z.object({
        userId: z.number().optional(),
        email: z.string().email().optional(),
      }).refine(d => d.userId !== undefined || d.email !== undefined, {
        message: 'userId أو email مطلوب',
      }))
      .query(async ({ input }) => {
        let records;
        if (input.userId) {
          records = await db.getPaymentHistoryByUserId(input.userId);
        } else {
          // بحث بالبريد الإلكتروني مباشرة
          records = await db.getPaymentHistoryByEmail(input.email!);
        }
        return records.map(r => ({
          id: r.id,
          gateway: r.gateway,
          chargeId: r.chargeId,
          amount: r.amount,
          currency: r.currency,
          plan: r.plan,
          status: r.status,
          cardLast4: r.cardLast4,
          cardBrand: r.cardBrand,
          referenceId: r.referenceId,
          errorMessage: r.errorMessage,
          createdAt: r.createdAt.toISOString(),
        }));
      }),

    /**
     * التحقق من حالة الدفع وتفعيل الاشتراك
     */
    verifyAndActivate: publicProcedure
      .input(
        z.object({
          gateway: z.enum(['tap', 'paddle', 'paypal', 'stcpay']),
          chargeId: z.string(),
          userId: z.number(),
          plan: z.enum(['monthly', 'yearly']),
          codeId: z.number().optional()
        })
      )
      .mutation(async ({ input }) => {
        const verify = await verifyPayment({
          gateway: input.gateway as PaymentGateway,
          chargeId: input.chargeId,
        });

        if (!verify.success || !verify.paid) {
          return {
            success: false,
            error: verify.error ?? 'لم يتم تأكيد الدفع بعد',
          };
        }

        // تفعيل الاشتراك في قاعدة البيانات
        const expiry = calcSubscriptionExpiry(input.plan);
        await db.updateAppUserSubscription(input.userId, input.plan, expiry);

        // تطبيق كود الخصم إن وجد
        if (input.codeId) {
          try {
            await db.incrementDiscountCodeUsage(input.codeId);
          } catch { /* non-critical */ }
        }

        return { success: true, plan: input.plan, expiry: expiry.toISOString() };
      }),

    /** استلام طلب تحويل STC Pay الشخصي وإرسال بريد للمسؤول والعميل */
    submitStcTransfer: publicProcedure
      .input(z.object({
        customerName: z.string().min(1),
        customerEmail: z.string().email(),
        customerPhone: z.string().optional(),
        plan: z.enum(['monthly', 'yearly']),
        amount: z.number(),
        receiptNote: z.string().optional(),
        userId: z.number().optional(),
        discountPercent: z.number().optional(),
        codeId: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const planLabel = input.plan === 'monthly' ? 'شهري (29 ر.س)' : 'سنوي (199 ر.س)';
        const submittedAt = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });

        // حفظ الطلب في سجل الدفعات (يُحفظ دائماً — بـ userId أو بـ customerEmail)
        let stcRecordId: number | undefined;
        try {
          stcRecordId = await db.insertPaymentHistory({
            userId: input.userId ?? undefined,
            customerEmail: input.userId ? undefined : input.customerEmail,
            gateway: 'stcpay',
            chargeId: `stc_pending_${Date.now()}`,
            amount: input.amount,
            currency: 'SAR',
            status: 'pending',
            plan: input.plan,
            cardBrand: 'STC Pay',
            referenceId: input.receiptNote ?? undefined
          });
          console.log(`[STC] Pending record saved: id=${stcRecordId}, userId=${input.userId ?? 'guest'}, email=${input.customerEmail}, amount=${input.amount / 100} SAR`);
        } catch (dbErr) {
          console.error('[STC] Failed to save pending record:', dbErr);
        }
        const stcDbSaved = stcRecordId !== undefined;

        // المبلغ الحقيقي للعرض (مخزّن بالهللات)
        const displayAmountSAR = (input.amount / 100).toFixed(0);

        // إرسال بريد إشعار للمسؤول
        const adminEmail = process.env.ADMIN_EMAIL || 'onboarding@resend.dev';
        console.log(`[STC] Sending admin notification to: ${adminEmail}`);
        const adminHtml = `
          <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; border-radius: 12px; overflow: hidden;">
            <div style="background: #7B2FBE; padding: 24px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 22px;">📱 طلب تحويل STC Pay جديد</h1>
              <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0;">يحتاج لمراجعة وتفعيل</p>
            </div>
            <div style="padding: 24px; background: #fff;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">اسم العميل</td><td style="padding: 10px; font-weight: bold;">${input.customerName}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">البريد الإلكتروني</td><td style="padding: 10px; font-weight: bold;">${input.customerEmail}</td></tr>
                ${input.customerPhone ? `<tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">رقم الجوال</td><td style="padding: 10px; font-weight: bold;">${input.customerPhone}</td></tr>` : ''}
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">نوع الاشتراك</td><td style="padding: 10px; font-weight: bold;">${planLabel}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">المبلغ المحوّل</td><td style="padding: 10px; font-weight: bold; color: #7B2FBE; font-size: 18px;">${displayAmountSAR} ر.س</td></tr>
                ${input.receiptNote ? `<tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">رقم المرجع</td><td style="padding: 10px; font-weight: bold;">${input.receiptNote}</td></tr>` : ''}
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">معرّف الطلب في DB</td><td style="padding: 10px;">${stcRecordId ?? 'لم يُحفظ'}</td></tr>
                <tr><td style="padding: 10px; color: #666;">وقت الطلب</td><td style="padding: 10px;">${submittedAt}</td></tr>
              </table>
              <div style="margin-top: 20px; padding: 16px; background: #FFF3CD; border-radius: 8px; border-right: 4px solid #F59E0B;">
                <p style="margin: 0; color: #856404; font-weight: bold;">⚠️ الإجراء المطلوب</p>
                <p style="margin: 8px 0 0; color: #856404;">تحقّق من استلام التحويل في تطبيق STC Pay، ثم فعّل الاشتراك يدوياً من لوحة التحكم.</p>
              </div>
            </div>
          </div>`;

        const stcAdminEmailResult = await sendEmail({
          to: adminEmail,
          subject: `📱 طلب STC Pay جديد — ${input.customerName} (${displayAmountSAR} ر.س)`,
          html: adminHtml,
        }).catch(err => ({ success: false, error: String(err) }));
        if (!stcAdminEmailResult.success) {
          console.error(`[STC] Admin email FAILED to ${adminEmail}:`, stcAdminEmailResult.error);
        } else {
          console.log(`[STC] Admin email sent to ${adminEmail}`);
        // إشعار Push فوري للمدير
        sendAdminNewPaymentPushNotification('stcpay', input.customerName, input.customerEmail, input.plan, `${displayAmountSAR} ر.س`).catch(() => {});
        }

        // إرسال بريد تأكيد للعميل
        const clientHtml = `
          <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; border-radius: 12px; overflow: hidden;">
            <div style="background: #7B2FBE; padding: 24px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 22px;">✅ تم استلام طلبك!</h1>
              <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0;">سيتم تفعيل اشتراكك خلال ساعات</p>
            </div>
            <div style="padding: 24px; background: #fff;">
              <p style="color: #333; line-height: 1.8;">مرحباً <strong>${input.customerName}</strong>،</p>
              <p style="color: #333; line-height: 1.8;">تم استلام طلب تفعيل اشتراكك عبر STC Pay بنجاح. سيقوم الفريق بمراجعة تحويلك وتفعيل اشتراكك خلال ساعات.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr style="background: #f5f5f5;"><td style="padding: 10px; color: #666;">نوع الاشتراك</td><td style="padding: 10px; font-weight: bold;">${planLabel}</td></tr>
                <tr><td style="padding: 10px; color: #666;">المبلغ</td><td style="padding: 10px; font-weight: bold; color: #7B2FBE;">${displayAmountSAR} ر.س</td></tr>
                ${input.receiptNote ? `<tr style="background: #f5f5f5;"><td style="padding: 10px; color: #666;">رقم المرجع</td><td style="padding: 10px;">${input.receiptNote}</td></tr>` : ''}
              </table>
              <p style="color: #666; font-size: 13px;">للاستفسار رد على هذا البريد أو تواصل معنا مباشرة.</p>
            </div>
          </div>`;

        await sendEmail({
          to: input.customerEmail,
          subject: '✅ تم استلام طلبك — كتاب+',
          html: clientHtml,
        }).catch(() => {});

        return { success: true, dbSaved: stcDbSaved };
      }),

    /**
     * طلب تحويل شخصي عبر PayPal
     */
    submitPayPalTransfer: publicProcedure
      .input(z.object({
        customerName: z.string().min(1),
        customerEmail: z.string().email(),
        plan: z.enum(['monthly', 'yearly']),
        amount: z.number(),
        currency: z.string().default('USD'),
        receiptNote: z.string().optional(),
        userId: z.number().optional(),
        discountPercent: z.number().optional(),
        codeId: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const planLabel = input.plan === 'monthly' ? 'شهري' : 'سنوي';
        const submittedAt = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });

        // حفظ الطلب في سجل الدفعات (يُحفظ دائماً — بـ userId أو بـ customerEmail)
        let paypalRecordId: number | undefined;
        try {
          paypalRecordId = await db.insertPaymentHistory({
            userId: input.userId ?? undefined,
            customerEmail: input.userId ? undefined : input.customerEmail,
            gateway: 'paypal',
            chargeId: `paypal_pending_${Date.now()}`,
            amount: input.amount,
            currency: 'USD',
            status: 'pending',
            plan: input.plan,
            cardBrand: 'PayPal',
            referenceId: input.receiptNote ?? undefined
          });
          console.log(`[PayPal] Pending record saved: id=${paypalRecordId}, userId=${input.userId ?? 'guest'}, email=${input.customerEmail}, amount=${input.amount / 100} USD`);
        } catch (dbErr) {
          console.error('[PayPal] Failed to save pending record:', dbErr);
        }
        const paypalDbSaved = paypalRecordId !== undefined;

        // المبلغ الحقيقي للعرض (مخزّن بالسنتات)
        const displayAmount = (input.amount / 100).toFixed(2);

        // إرسال بريد إشعار للمسؤول
        const adminEmail = process.env.ADMIN_EMAIL || 'onboarding@resend.dev';
        console.log(`[PayPal] Sending admin notification to: ${adminEmail}`);
        const adminHtml = `
          <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; border-radius: 12px; overflow: hidden;">
            <div style="background: #003087; padding: 24px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 22px;">🅿️ طلب تحويل PayPal جديد</h1>
              <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0;">يحتاج لمراجعة وتفعيل</p>
            </div>
            <div style="padding: 24px; background: #fff;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">اسم العميل</td><td style="padding: 10px; font-weight: bold;">${input.customerName}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">البريد الإلكتروني</td><td style="padding: 10px; font-weight: bold;">${input.customerEmail}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">نوع الاشتراك</td><td style="padding: 10px; font-weight: bold;">${planLabel}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">المبلغ المحوّل</td><td style="padding: 10px; font-weight: bold; color: #003087; font-size: 18px;">$${displayAmount} USD</td></tr>
                ${input.receiptNote ? `<tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">رقم المرجع</td><td style="padding: 10px; font-weight: bold;">${input.receiptNote}</td></tr>` : ''}
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">معرّف الطلب في DB</td><td style="padding: 10px;">${paypalRecordId ?? 'لم يُحفظ'}</td></tr>
                <tr><td style="padding: 10px; color: #666;">وقت الطلب</td><td style="padding: 10px;">${submittedAt}</td></tr>
              </table>
              <div style="margin-top: 20px; padding: 16px; background: #E3F2FD; border-radius: 8px; border-right: 4px solid #003087;">
                <p style="margin: 0; color: #003087; font-weight: bold;">⚠️ الإجراء المطلوب</p>
                <p style="margin: 8px 0 0; color: #003087;">تحقّق من استلام التحويل في حساب PayPal الخاص بك (paypal.me/msd76)، ثم فعّل الاشتراك من لوحة التحكم.</p>
              </div>
            </div>
          </div>`;

        const adminEmailResult = await sendEmail({
          to: adminEmail,
          subject: `🅿️ طلب PayPal جديد — ${input.customerName} ($${displayAmount} USD)`,
          html: adminHtml,
        }).catch(err => ({ success: false, error: String(err) }));
        if (!adminEmailResult.success) {
          console.error(`[PayPal] Admin email FAILED to ${adminEmail}:`, adminEmailResult.error);
        } else {
          console.log(`[PayPal] Admin email sent to ${adminEmail}`);
        // إشعار Push فوري للمدير
        sendAdminNewPaymentPushNotification('paypal', input.customerName, input.customerEmail, input.plan, `${displayAmount} USD`).catch(() => {});
        }

        // إرسال بريد تأكيد للعميل
        const clientHtml = `
          <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; border-radius: 12px; overflow: hidden;">
            <div style="background: #003087; padding: 24px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 22px;">✅ تم استلام طلبك!</h1>
              <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0;">سيتم تفعيل اشتراكك خلال ساعات</p>
            </div>
            <div style="padding: 24px; background: #fff;">
              <p style="color: #333; line-height: 1.8;">مرحباً <strong>${input.customerName}</strong>،</p>
              <p style="color: #333; line-height: 1.8;">تم استلام طلب تفعيل اشتراكك عبر PayPal بنجاح. سيقوم الفريق بمراجعة تحويلك وتفعيل اشتراكك خلال ساعات.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr style="background: #f5f5f5;"><td style="padding: 10px; color: #666;">نوع الاشتراك</td><td style="padding: 10px; font-weight: bold;">${planLabel}</td></tr>
                <tr><td style="padding: 10px; color: #666;">المبلغ</td><td style="padding: 10px; font-weight: bold; color: #003087;">$${displayAmount} USD</td></tr>
                ${input.receiptNote ? `<tr style="background: #f5f5f5;"><td style="padding: 10px; color: #666;">رقم المرجع</td><td style="padding: 10px;">${input.receiptNote}</td></tr>` : ''}
              </table>
              <p style="color: #666; font-size: 13px;">للاستفسار رد على هذا البريد أو تواصل معنا مباشرة.</p>
            </div>
          </div>`;

        await sendEmail({
          to: input.customerEmail,
          subject: '✅ تم استلام طلبك — كتاب+',
          html: clientHtml,
        }).catch(() => {});

        return { success: true, dbSaved: paypalDbSaved };
      }),

    /**
     * طلب تحويل شخصي عبر Wise
     */
    submitWiseTransfer: publicProcedure
      .input(z.object({
        customerName: z.string().min(1),
        customerEmail: z.string().email(),
        plan: z.enum(['monthly', 'yearly']),
        amount: z.number(),
        currency: z.string().default('USD'),
        receiptNote: z.string().optional(),
        userId: z.number().optional(),
        discountPercent: z.number().optional(),
        codeId: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const planLabel = input.plan === 'monthly' ? 'شهري' : 'سنوي';
        const submittedAt = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });

        // حفظ الطلب في سجل الدفعات (يُحفظ دائماً — بـ userId أو بـ customerEmail)
        let wiseRecordId: number | undefined;
        try {
          wiseRecordId = await db.insertPaymentHistory({
            userId: input.userId ?? undefined,
            customerEmail: input.userId ? undefined : input.customerEmail,
            gateway: 'wise',
            chargeId: `wise_pending_${Date.now()}`,
            amount: input.amount,
            currency: 'USD',
            status: 'pending',
            plan: input.plan,
            cardBrand: 'Wise',
            referenceId: input.receiptNote ?? undefined
          });
          console.log(`[Wise] Pending record saved: id=${wiseRecordId}, userId=${input.userId ?? 'guest'}, email=${input.customerEmail}, amount=${input.amount / 100} USD`);
        } catch (dbErr) {
          console.error('[Wise] Failed to save pending record:', dbErr);
        }
        const wiseDbSaved = wiseRecordId !== undefined;

        // المبلغ الحقيقي للعرض (مخزّن بالسنتات)
        const displayAmount = (input.amount / 100).toFixed(2);

        // إرسال بريد إشعار للمسؤول
        const adminEmail = process.env.ADMIN_EMAIL || 'onboarding@resend.dev';
        console.log(`[Wise] Sending admin notification to: ${adminEmail}`);
        const adminHtml = `
          <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; border-radius: 12px; overflow: hidden;">
            <div style="background: #00B9A5; padding: 24px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 22px;">🟢 طلب تحويل Wise جديد</h1>
              <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0;">يحتاج لمراجعة وتفعيل</p>
            </div>
            <div style="padding: 24px; background: #fff;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">اسم العميل</td><td style="padding: 10px; font-weight: bold;">${input.customerName}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">البريد الإلكتروني</td><td style="padding: 10px; font-weight: bold;">${input.customerEmail}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">نوع الاشتراك</td><td style="padding: 10px; font-weight: bold;">${planLabel}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">المبلغ المحوّل</td><td style="padding: 10px; font-weight: bold; color: #00B9A5; font-size: 18px;">$${displayAmount} USD</td></tr>
                ${input.receiptNote ? `<tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">رقم المرجع</td><td style="padding: 10px; font-weight: bold;">${input.receiptNote}</td></tr>` : ''}
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">معرّف الطلب في DB</td><td style="padding: 10px;">${wiseRecordId ?? 'لم يُحفظ'}</td></tr>
                <tr><td style="padding: 10px; color: #666;">وقت الطلب</td><td style="padding: 10px;">${submittedAt}</td></tr>
              </table>
              <div style="margin-top: 20px; padding: 16px; background: #E0FFF9; border-radius: 8px; border-right: 4px solid #00B9A5;">
                <p style="margin: 0; color: #00B9A5; font-weight: bold;">⚠️ الإجراء المطلوب</p>
                <p style="margin: 8px 0 0; color: #007a6e;">تحقّق من استلام التحويل في تطبيق Wise (حساب Mohannad Abdulmonem Saifiddin)، ثم فعّل الاشتراك من لوحة التحكم.</p>
              </div>
            </div>
          </div>`;

        const adminEmailResult = await sendEmail({
          to: adminEmail,
          subject: `🟢 طلب Wise جديد — ${input.customerName} ($${displayAmount} USD)`,
          html: adminHtml,
        }).catch(err => ({ success: false, error: String(err) }));
        if (!adminEmailResult.success) {
          console.error(`[Wise] Admin email FAILED to ${adminEmail}:`, adminEmailResult.error);
        } else {
          console.log(`[Wise] Admin email sent to ${adminEmail}`);
        // إشعار Push فوري للمدير
        sendAdminNewPaymentPushNotification('wise', input.customerName, input.customerEmail, input.plan, `${displayAmount} USD`).catch(() => {});
        }

        // إرسال بريد تأكيد للعميل
        const clientHtml = `
          <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; border-radius: 12px; overflow: hidden;">
            <div style="background: #00B9A5; padding: 24px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 22px;">✅ تم استلام طلبك!</h1>
              <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0;">سيتم تفعيل اشتراكك خلال ساعات</p>
            </div>
            <div style="padding: 24px; background: #fff;">
              <p style="color: #333; line-height: 1.8;">مرحباً <strong>${input.customerName}</strong>،</p>
              <p style="color: #333; line-height: 1.8;">تم استلام طلب تفعيل اشتراكك عبر Wise بنجاح. سيقوم الفريق بمراجعة تحويلك وتفعيل اشتراكك خلال ساعات.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr style="background: #f5f5f5;"><td style="padding: 10px; color: #666;">نوع الاشتراك</td><td style="padding: 10px; font-weight: bold;">${planLabel}</td></tr>
                <tr><td style="padding: 10px; color: #666;">المبلغ</td><td style="padding: 10px; font-weight: bold; color: #00B9A5;">$${displayAmount} USD</td></tr>
                ${input.receiptNote ? `<tr style="background: #f5f5f5;"><td style="padding: 10px; color: #666;">رقم المرجع</td><td style="padding: 10px;">${input.receiptNote}</td></tr>` : ''}
              </table>
              <p style="color: #666; font-size: 13px;">للاستفسار رد على هذا البريد أو تواصل معنا مباشرة.</p>
            </div>
          </div>`;

        await sendEmail({
          to: input.customerEmail,
          subject: '✅ تم استلام طلبك — كتاب+',
          html: clientHtml,
        }).catch(() => {});

        return { success: true, dbSaved: wiseDbSaved };
      }),

    /**
     * إرسال طلب تحويل IBAN بنكي (البنك الأهلي السعودي)
     */
    submitIbanTransfer: publicProcedure
      .input(z.object({
        customerName: z.string().min(1),
        customerEmail: z.string().email(),
        plan: z.enum(['monthly', 'yearly']),
        amount: z.number(),
        currency: z.string().default('SAR'),
        receiptNote: z.string().optional(),
        userId: z.number().optional(),
        discountPercent: z.number().optional(),
        codeId: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const planLabel = input.plan === 'monthly' ? 'شهري' : 'سنوي';
        const submittedAt = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });

        // حفظ الطلب في سجل الدفعات (يُحفظ دائماً — بـ userId أو بـ customerEmail)
        let ibanRecordId: number | undefined;
        try {
          ibanRecordId = await db.insertPaymentHistory({
            userId: input.userId ?? undefined,
            customerEmail: input.userId ? undefined : input.customerEmail,
            gateway: 'iban',
            chargeId: `iban_pending_${Date.now()}`,
            amount: input.amount,
            currency: 'SAR',
            status: 'pending',
            plan: input.plan,
            cardBrand: 'IBAN',
            referenceId: input.receiptNote ?? undefined
          });
          console.log(`[IBAN] Pending record saved: id=${ibanRecordId}, userId=${input.userId ?? 'guest'}, email=${input.customerEmail}, amount=${input.amount / 100} SAR`);
        } catch (dbErr) {
          console.error('[IBAN] Failed to save pending record:', dbErr);
        }
        const ibanDbSaved = ibanRecordId !== undefined;

        // المبلغ الحقيقي للعرض (مخزّن بالهللات)
        const displayAmountSAR = (input.amount / 100).toFixed(2);

        // إرسال بريد إشعار للمسؤول
        const adminEmail = process.env.ADMIN_EMAIL || 'onboarding@resend.dev';
        console.log(`[IBAN] Sending admin notification to: ${adminEmail}`);
        const adminHtml = `
          <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; border-radius: 12px; overflow: hidden;">
            <div style="background: #1D4ED8; padding: 24px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 22px;">🏦 طلب تحويل IBAN جديد</h1>
              <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0;">يحتاج لمراجعة وتفعيل</p>
            </div>
            <div style="padding: 24px; background: #fff;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">اسم العميل</td><td style="padding: 10px; font-weight: bold;">${input.customerName}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">البريد الإلكتروني</td><td style="padding: 10px; font-weight: bold;">${input.customerEmail}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">نوع الاشتراك</td><td style="padding: 10px; font-weight: bold;">${planLabel}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">المبلغ المحوّل</td><td style="padding: 10px; font-weight: bold; color: #1D4ED8; font-size: 18px;">${displayAmountSAR} ر.س</td></tr>
                ${input.receiptNote ? `<tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">رقم المرجع</td><td style="padding: 10px; font-weight: bold;">${input.receiptNote}</td></tr>` : ''}
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">معرّف الطلب في DB</td><td style="padding: 10px;">${ibanRecordId ?? 'لم يُحفظ'}</td></tr>
                <tr><td style="padding: 10px; color: #666;">وقت الطلب</td><td style="padding: 10px;">${submittedAt}</td></tr>
              </table>
              <div style="margin-top: 20px; padding: 16px; background: #EEF2FF; border-radius: 8px; border-right: 4px solid #1D4ED8;">
                <p style="margin: 0; color: #1D4ED8; font-weight: bold;">⚠️ الإجراء المطلوب</p>
                <p style="margin: 8px 0 0; color: #1e40af;">تحقّق من استلام التحويل في تطبيق البنك الأهلي السعودي (SNB) إلى IBAN: SA1010000007961432000109، ثم فعّل الاشتراك من لوحة التحكم.</p>
              </div>
            </div>
          </div>`;

        const adminEmailResult = await sendEmail({
          to: adminEmail,
          subject: `🏦 طلب IBAN جديد — ${input.customerName} (${displayAmountSAR} ر.س)`,
          html: adminHtml,
        }).catch(err => ({ success: false, error: String(err) }));
        if (!adminEmailResult.success) {
          console.error(`[IBAN] Admin email FAILED to ${adminEmail}:`, (adminEmailResult as any).error);
        } else {
          console.log(`[IBAN] Admin email sent to ${adminEmail}`);
        // إشعار Push فوري للمدير
        sendAdminNewPaymentPushNotification('iban', input.customerName, input.customerEmail, input.plan, `${displayAmountSAR} ر.س`).catch(() => {});
        }

        // إرسال بريد تأكيد للعميل
        const clientHtml = `
          <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; border-radius: 12px; overflow: hidden;">
            <div style="background: #1D4ED8; padding: 24px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 22px;">✅ تم استلام طلبك!</h1>
              <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0;">سيتم تفعيل اشتراكك خلال ساعات</p>
            </div>
            <div style="padding: 24px; background: #fff;">
              <p style="color: #333; line-height: 1.8;">مرحباً <strong>${input.customerName}</strong>،</p>
              <p style="color: #333; line-height: 1.8;">تم استلام طلب تفعيل اشتراكك عبر التحويل البنكي (IBAN) بنجاح. سيقوم الفريق بمراجعة تحويلك وتفعيل اشتراكك خلال ساعات.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr style="background: #f5f5f5;"><td style="padding: 10px; color: #666;">نوع الاشتراك</td><td style="padding: 10px; font-weight: bold;">${planLabel}</td></tr>
                <tr><td style="padding: 10px; color: #666;">المبلغ</td><td style="padding: 10px; font-weight: bold; color: #1D4ED8;">${displayAmountSAR} ر.س</td></tr>
                ${input.receiptNote ? `<tr style="background: #f5f5f5;"><td style="padding: 10px; color: #666;">رقم المرجع</td><td style="padding: 10px;">${input.receiptNote}</td></tr>` : ''}
              </table>
              <p style="color: #666; font-size: 13px;">للاستفسار رد على هذا البريد أو تواصل معنا مباشرة.</p>
            </div>
          </div>`;

        await sendEmail({
          to: input.customerEmail,
          subject: '✅ تم استلام طلبك — كتاب+',
          html: clientHtml,
        }).catch(() => {});

        return { success: true, dbSaved: ibanDbSaved };
      }),

    /**
     * إرسال طلب تحويل عملة رقمية (USDT/BTC) يدوياً
     */
    submitCryptoTransfer: publicProcedure
      .input(z.object({
        customerName: z.string().min(1),
        customerEmail: z.string().email(),
        plan: z.enum(['monthly', 'yearly']),
        amount: z.number(),
        currency: z.string().default('USD'),
        coin: z.enum(['usdt', 'btc']),
        txid: z.string().min(1),
        userId: z.number().optional(),
        discountPercent: z.number().optional(),
        codeId: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const planLabel = input.plan === 'monthly' ? 'شهري' : 'سنوي';
        const coinLabel = input.coin === 'usdt' ? 'USDT / TRC20' : 'BTC / BEP20';
        const submittedAt = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });
        const displayAmount = (input.amount / 100).toFixed(2);

        // حفظ الطلب في سجل الدفعات
        let cryptoRecordId: number | undefined;
        try {
          cryptoRecordId = await db.insertPaymentHistory({
            userId: input.userId ?? undefined,
            customerEmail: input.userId ? undefined : input.customerEmail,
            gateway: 'crypto',
            chargeId: `crypto_pending_${Date.now()}`,
            amount: input.amount,
            currency: 'USD',
            status: 'pending',
            plan: input.plan,
            cardBrand: coinLabel,
            referenceId: input.txid
          });
          console.log(`[Crypto] Pending record saved: id=${cryptoRecordId}, coin=${input.coin}, txid=${input.txid}`);
        } catch (dbErr) {
          console.error('[Crypto] Failed to save pending record:', dbErr);
        }

        // إرسال بريد إشعار للمسؤول
        const adminEmail = process.env.ADMIN_EMAIL || 'onboarding@resend.dev';
        const adminHtml = `
          <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; border-radius: 12px; overflow: hidden;">
            <div style="background: #F7931A; padding: 24px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 22px;">₿ طلب تحويل عملة رقمية جديد</h1>
              <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0;">يحتاج لمراجعة وتفعيل</p>
            </div>
            <div style="padding: 24px; background: #fff;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">اسم العميل</td><td style="padding: 10px; font-weight: bold;">${input.customerName}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">البريد الإلكتروني</td><td style="padding: 10px; font-weight: bold;">${input.customerEmail}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">نوع العملة</td><td style="padding: 10px; font-weight: bold; color: #F7931A;">${coinLabel}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">رقم المعاملة TxID</td><td style="padding: 10px; font-weight: bold; font-family: monospace; font-size: 12px;">${input.txid}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">نوع الاشتراك</td><td style="padding: 10px; font-weight: bold;">${planLabel}</td></tr>
                <tr style="border-bottom: 1px solid #eee;"><td style="padding: 10px; color: #666;">المبلغ</td><td style="padding: 10px; font-weight: bold; color: #F7931A; font-size: 18px;">$ ${displayAmount} USD</td></tr>
                <tr><td style="padding: 10px; color: #666;">وقت الطلب</td><td style="padding: 10px;">${submittedAt}</td></tr>
              </table>
              <div style="margin-top: 20px; padding: 16px; background: #FFF7ED; border-radius: 8px; border-right: 4px solid #F7931A;">
                <p style="margin: 0; color: #F7931A; font-weight: bold;">⚠️ الإجراء المطلوب</p>
                <p style="margin: 8px 0 0; color: #92400e;">تحقّق من رقم المعاملة TxID على البلوكشين (TronScan لـ USDT أو BscScan لـ BTC).، ثم فعّل الاشتراك من لوحة التحكم.</p>
              </div>
            </div>
          </div>`;

        await sendEmail({
          to: adminEmail,
          subject: `₿ طلب Crypto جديد — ${input.customerName} (${coinLabel})`,
          html: adminHtml,
        }).catch(() => {});

        sendAdminNewPaymentPushNotification('crypto', input.customerName, input.customerEmail, input.plan, `$${displayAmount} ${coinLabel}`).catch(() => {});

        // إرسال بريد تأكيد للعميل
        const clientHtml = `
          <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; border-radius: 12px; overflow: hidden;">
            <div style="background: #F7931A; padding: 24px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 22px;">✅ تم استلام طلبك!</h1>
              <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0;">سيتم تفعيل اشتراكك خلال 24 ساعة</p>
            </div>
            <div style="padding: 24px; background: #fff;">
              <p style="color: #333; line-height: 1.8;">مرحباً <strong>${input.customerName}</strong>،</p>
              <p style="color: #333; line-height: 1.8;">تم استلام طلب تفعيل اشتراكك عبر ${coinLabel} بنجاح. سيقوم الفريق بمراجعة رقم المعاملة وتفعيل اشتراكك خلال 24 ساعة.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr style="background: #f5f5f5;"><td style="padding: 10px; color: #666;">نوع العملة</td><td style="padding: 10px; font-weight: bold; color: #F7931A;">${coinLabel}</td></tr>
                <tr><td style="padding: 10px; color: #666;">رقم المعاملة TxID</td><td style="padding: 10px; font-family: monospace; font-size: 12px;">${input.txid}</td></tr>
                <tr style="background: #f5f5f5;"><td style="padding: 10px; color: #666;">نوع الاشتراك</td><td style="padding: 10px; font-weight: bold;">${planLabel}</td></tr>
                <tr><td style="padding: 10px; color: #666;">المبلغ</td><td style="padding: 10px; font-weight: bold; color: #F7931A;">$ ${displayAmount} USD</td></tr>
              </table>
              <p style="color: #666; font-size: 13px;">للاستفسار رد على هذا البريد أو تواصل معنا عبر Telegram: @KitabPlusApp</p>
            </div>
          </div>`;

        await sendEmail({
          to: input.customerEmail,
          subject: '✅ تم استلام طلبك — كتاب+',
          html: clientHtml,
        }).catch(() => {});

        return { success: true, dbSaved: cryptoRecordId !== undefined };
      }),

    /**
     * التحقق من صحة إعداد البوابات (للاختبار)
     */
    gatewayStatus: publicProcedure.query(() => {
      return {
        tap: {
          configured: !!process.env.TAP_SECRET_KEY,
          publicKey: process.env.TAP_PUBLIC_KEY ?? null,
          mode: process.env.TAP_SECRET_KEY?.startsWith('sk_live') ? 'live' : 'sandbox',
        },
        paddle: {
          configured: !!process.env.PADDLE_API_KEY,
          vendorId: process.env.PADDLE_VENDOR_ID ?? null,
          mode: process.env.PADDLE_API_KEY?.startsWith('test_') ? 'sandbox' : 'live',
          monthlyPriceId: process.env.PADDLE_MONTHLY_PRICE_ID ?? null,
          yearlyPriceId: process.env.PADDLE_YEARLY_PRICE_ID ?? null,
        },
      };
    }),
  }),

  // ── Discount Codes ────────────────────────────────────────────────────────────
  discount: router({
    /**
     * التحقق من صحة كود الخصم وإرجاع نسبة الخصم
     */
    validate: publicProcedure
      .input(z.object({ code: z.string().min(1).max(50) }))
      .mutation(async ({ input }) => {
        const code = await db.getDiscountCodeByCode(input.code);
        if (!code) {
          return { valid: false, error: "كود الخصم غير صحيح" };
        }
        if (code.isActive !== "1") {
          return { valid: false, error: "كود الخصم غير مفعّل" };
        }
        if (code.expiresAt && new Date(code.expiresAt) < new Date()) {
          return { valid: false, error: "كود الخصم منتهي الصلاحية" };
        }
        if (code.maxUses !== null && code.usedCount >= code.maxUses) {
          return { valid: false, error: "تم استنفاد عدد الاستخدامات المسموحة لهذا الكود" };
        }
        return {
          valid: true,
          discountPercent: code.discountPercent,
          codeId: code.id,
        };
      }),

    /**
     * تطبيق كود الخصم (زيادة عداد الاستخدام)
     */
    useCode: publicProcedure
      .input(z.object({ codeId: z.number() }))
      .mutation(async ({ input }) => {
        await db.incrementDiscountCodeUsage(input.codeId);
        return { success: true };
      }),

    /**
     * جلب جميع الأكواد (للمدير فقط)
     */
    list: publicProcedure.query(async () => {
      const codes = await db.getAllDiscountCodes();
      return codes.map(c => ({
        id: c.id,
        code: c.code,
        discountPercent: c.discountPercent,
        maxUses: c.maxUses,
        usedCount: c.usedCount,
        isActive: c.isActive === "1",
        expiresAt: c.expiresAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      }));
    }),

    /**
     * إنشاء كود خصم جديد (للمدير فقط)
     */
    create: publicProcedure
      .input(z.object({
        code: z.string().min(3).max(50),
        discountPercent: z.number().min(1).max(100),
        maxUses: z.number().min(1).nullable().optional(),
        expiresAt: z.string().nullable().optional(),
      }))
      .mutation(async ({ input }) => {
        const existing = await db.getDiscountCodeByCode(input.code);
        if (existing) {
          return { success: false, error: "كود الخصم موجود بالفعل" };
        }
        await db.createDiscountCode({
          code: input.code,
          discountPercent: input.discountPercent,
          maxUses: input.maxUses ?? undefined,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
        });
        return { success: true };
      }),

    /**
     * تفعيل/تعطيل كود خصم (للمدير فقط)
     */
    toggle: publicProcedure
      .input(z.object({ id: z.number(), isActive: z.boolean() }))
      .mutation(async ({ input }) => {
        await db.toggleDiscountCodeStatus(input.id, input.isActive ? "1" : "0");
        return { success: true };
      }),

    /**
     * حذف كود خصم (للمدير فقط)
     */
    delete: publicProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteDiscountCode(input.id);
        return { success: true };
      }),
  }),

  // ── Admin: Payment Events ────────────────────────────────────────────────────────────
  adminPayments: router({
    /**
     * جلب سجل المدفوعات (للمدير فقط)
     */
    list: publicProcedure
      .input(z.object({ limit: z.number().min(1).max(500).default(100) }))
      .query(async ({ input }) => {
        const events = await db.getPaymentEvents(input.limit);
        return events.map(e => ({
          id: e.id,
          gateway: e.gateway,
          eventType: e.eventType,
          chargeId: e.chargeId,
          orderId: e.orderId ?? null,
          customerEmail: e.customerEmail ?? null,
          amount: e.amount ?? null,
          currency: e.currency ?? null,
          plan: e.plan ?? null,
          userId: e.userId ?? null,
          status: e.status,
          errorMessage: e.errorMessage ?? null,
          createdAt: e.createdAt.toISOString(),
        }));
      }),

    /**
     * إحصائيات سريعة للوحة المدير
     */
    stats: publicProcedure.query(async () => {
      const events = await db.getPaymentEvents(500);
      const total = events.length;
      const processed = events.filter(e => e.status === 'processed').length;
      const skipped = events.filter(e => e.status === 'skipped').length;
      const errors = events.filter(e => e.status === 'error').length;
      const tapTotal = events.filter(e => e.gateway === 'tap').length;
      const paddleTotal = events.filter(e => e.gateway === 'paddle').length;
      const monthlyTotal = events.filter(e => e.plan === 'monthly' && e.status === 'processed').length;
      const yearlyTotal = events.filter(e => e.plan === 'yearly' && e.status === 'processed').length;
      const revenue = events
        .filter(e => e.status === 'processed')
        .reduce((sum, e) => sum + ((e.amount ?? 0) / 100), 0);
      return { total, processed, skipped, errors, tapTotal, paddleTotal, monthlyTotal, yearlyTotal, revenue: Math.round(revenue) };
    }),

    /**
     * إعادة معالجة حدث فاشل يدوياً
     */
    reprocess: publicProcedure
      .input(z.object({ eventId: z.number() }))
      .mutation(async ({ input }) => {
        const events = await db.getPaymentEvents(500);
        const event = events.find(e => e.id === input.eventId);
        if (!event) return { success: false, error: 'الحدث غير موجود' };
        if (!event.customerEmail) return { success: false, error: 'لا يوجد بريد إلكتروني لإعادة المعالجة' };
        const user = await db.getAppUserByEmail(event.customerEmail);
        if (!user) return { success: false, error: `لم يُعثر على مستخدم بالبريد: ${event.customerEmail}` };
        const plan = (event.plan ?? 'monthly') as 'monthly' | 'yearly';
        const expiry = calcSubscriptionExpiry(plan);
        await db.updateAppUserSubscription(user.id, plan, expiry);
        await sendEmail({
          to: event.customerEmail,
          subject: 'تم تفعيل اشتراكك — كتاب+',
          html: buildSubscriptionConfirmEmailHtml(user.name, plan, expiry),
        });
        return { success: true, userId: user.id, plan, expiry: expiry.toISOString() };
      }),

    /**
     * بيانات الإيرادات الشهرية (آخر 12 شهر)
     */
    monthlyRevenue: publicProcedure.query(async () => {
      const events = await db.getPaymentEvents(2000);
      const processed = events.filter(e => e.status === 'processed' && e.amount);
      // تجميع الإيرادات حسب الشهر
      const map: Record<string, { month: string; tap: number; paddle: number; total: number }> = {};
      for (const e of processed) {
        const d = new Date(e.createdAt);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const label = d.toLocaleDateString('ar-SA', { month: 'short', year: '2-digit' });
        if (!map[key]) map[key] = { month: label, tap: 0, paddle: 0, total: 0 };
        const amt = (e.amount ?? 0) / 100;
        if (e.gateway === 'tap') map[key].tap += amt;
        else map[key].paddle += amt;
        map[key].total += amt;
      }
      // آخر 12 شهر مرتبة
      const sorted = Object.entries(map)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-12)
        .map(([, v]) => ({ ...v, tap: Math.round(v.tap), paddle: Math.round(v.paddle), total: Math.round(v.total) }));
      return sorted;
    }),
    /**
     * جلب طلبات STC Pay المعلّقة (للمدير)
     */
    listPendingStc: publicProcedure.query(async () => {
      const records = await db.getPendingStcPayments(100);
      const results = await Promise.all(records.map(async r => {
        // البحث عن المستخدم بالمعرف أولاً ثم بالبريد
        let user = r.userId ? await db.getAppUserById(r.userId) : null;
        if (!user && r.customerEmail) user = await db.getAppUserByEmail(r.customerEmail);
        return {
          id: r.id,
          userId: r.userId,
          userEmail: user?.email ?? r.customerEmail ?? null,
          userName: user?.name ?? (r.customerEmail ? r.customerEmail.split("@")[0] : null),
          userExists: user !== null,
          amount: r.amount,
          currency: r.currency ?? 'SAR',
          plan: r.plan ?? 'monthly',
          referenceId: r.referenceId ?? null,
          status: r.status,
          createdAt: r.createdAt.toISOString()
        };
      }));
      return results;
    }),
    /**
     * تفعيل اشتراك مستخدم بعد التحقق من تحويل STC Pay
     */
    activateStcSubscription: publicProcedure
      .input(z.object({
        recordId: z.number(),
        userId: z.number().nullable().optional(),
        userEmail: z.string().email().optional(),
        plan: z.enum(['monthly', 'yearly']),
      }))
      .mutation(async ({ input }) => {
        let user = input.userId ? await db.getAppUserById(input.userId) : undefined;
        if (!user && input.userEmail) user = await db.getAppUserByEmail(input.userEmail);
        if (!user) return { success: false, error: 'المستخدم غير موجود' };
        const resolvedUserId = user.id;
        const expiry = calcSubscriptionExpiry(input.plan);
        await db.updateAppUserSubscription(resolvedUserId, input.plan, expiry);
        await db.updatePaymentHistoryStatus(input.recordId, 'success');
        // إرسال بريد تأكيد للمستخدم
        if (user.email) {
          await sendEmail({
            to: user.email,
            subject: 'تم تفعيل اشتراكك — كتاب+',
            html: buildSubscriptionConfirmEmailHtml(
              user.name ?? 'عزيزي المشترك',
              input.plan,
              expiry
            ),
          });
        }
        // إرسال Push Notification فوري لتأكيد تفعيل الاشتراك
        try {
          const pushToken = await db.getPushTokenByUserId(resolvedUserId);
          if (pushToken) {
            const planLabel = input.plan === 'monthly' ? 'الشهري (29 ر.س)' : 'السنوي (199 ر.س)';
            const expiryStr = expiry.toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' });
            await sendSubscriptionActivatedPushNotification(
              pushToken.token,
              user.name ?? 'عزيزي المشترك',
              planLabel,
              expiryStr
            );
            // إشعار ترحيبي للانضمام إلى قناة VIP
            await sendVIPChannelWelcomeNotification(pushToken.token, user.name ?? 'عزيزي المشترك').catch(() => {});
            console.log(`[STC] Push notification sent to userId=${resolvedUserId}`);
          }
        } catch (pushErr) {
          console.warn('[STC] Failed to send push notification:', pushErr);
        }
        return { success: true, userId: resolvedUserId, plan: input.plan, expiry: expiry.toISOString() };
      }),

    /**
     * جلب طلبات PayPal المعلّقة
     */
    listPendingPayPal: publicProcedure.query(async () => {
      const records = await db.getPendingPayPalPayments(100);
      const results = await Promise.all(records.map(async r => {
        let user = r.userId ? await db.getAppUserById(r.userId) : null;
        if (!user && r.customerEmail) user = await db.getAppUserByEmail(r.customerEmail);
        return {
          id: r.id,
          userId: r.userId,
          userEmail: user?.email ?? r.customerEmail ?? null,
          userName: user?.name ?? (r.customerEmail ? r.customerEmail.split("@")[0] : null),
          userExists: user !== null,
          amount: r.amount,
          currency: r.currency ?? 'USD',
          plan: r.plan ?? 'monthly',
          referenceId: r.referenceId ?? null,
          status: r.status,
          createdAt: r.createdAt.toISOString()
        };
      }));
      return results;
    }),

    /**
     * تفعيل اشتراك مستخدم بعد التحقق من تحويل PayPal
     */
    activatePayPalSubscription: publicProcedure
      .input(z.object({
        recordId: z.number(),
        userId: z.number().nullable().optional(),
        userEmail: z.string().email().optional(),
        plan: z.enum(['monthly', 'yearly']),
      }))
      .mutation(async ({ input }) => {
        let user = input.userId ? await db.getAppUserById(input.userId) : undefined;
        if (!user && input.userEmail) user = await db.getAppUserByEmail(input.userEmail);
        if (!user) return { success: false, error: 'المستخدم غير موجود' };
        const resolvedUserId = user.id;
        const expiry = calcSubscriptionExpiry(input.plan);
        await db.updateAppUserSubscription(resolvedUserId, input.plan, expiry);
        await db.updatePaymentHistoryStatus(input.recordId, 'success');
        if (user.email) {
          await sendEmail({
            to: user.email,
            subject: 'تم تفعيل اشتراكك — كتاب+',
            html: buildSubscriptionConfirmEmailHtml(
              user.name ?? 'عزيزي المشترك',
              input.plan,
              expiry
            ),
          });
        }
        try {
          const pushToken = await db.getPushTokenByUserId(resolvedUserId);
          if (pushToken) {
            const planLabel = input.plan === 'monthly' ? 'الشهري' : 'السنوي';
            const expiryStr = expiry.toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' });
            await sendSubscriptionActivatedPushNotification(
              pushToken.token,
              user.name ?? 'عزيزي المشترك',
              planLabel,
              expiryStr
            );
            await sendVIPChannelWelcomeNotification(pushToken.token, user.name ?? 'عزيزي المشترك').catch(() => {});
          }
        } catch { /* non-critical */ }
        // نظام الإحالة تم حذفه
        return { success: true, userId: resolvedUserId, plan: input.plan, expiry: expiry.toISOString() };
      }),

    /**
     * جلب طلبات Wise المعلّقة
     */
    listPendingWise: publicProcedure.query(async () => {
      const records = await db.getPendingWisePayments(100);
      const results = await Promise.all(records.map(async r => {
        let user = r.userId ? await db.getAppUserById(r.userId) : null;
        if (!user && r.customerEmail) user = await db.getAppUserByEmail(r.customerEmail);
        return {
          id: r.id,
          userId: r.userId,
          userEmail: user?.email ?? r.customerEmail ?? null,
          userName: user?.name ?? (r.customerEmail ? r.customerEmail.split("@")[0] : null),
          userExists: user !== null,
          amount: r.amount,
          currency: r.currency ?? 'USD',
          plan: r.plan ?? 'monthly',
          referenceId: r.referenceId ?? null,
          status: r.status,
          createdAt: r.createdAt.toISOString()
        };
      }));
      return results;
    }),

    /**
     * تفعيل اشتراك مستخدم بعد التحقق من تحويل Wise
     */
    activateWiseSubscription: publicProcedure
      .input(z.object({
        recordId: z.number(),
        userId: z.number().nullable().optional(),
        userEmail: z.string().email().optional(),
        plan: z.enum(['monthly', 'yearly']),
      }))
      .mutation(async ({ input }) => {
        let user = input.userId ? await db.getAppUserById(input.userId) : undefined;
        if (!user && input.userEmail) user = await db.getAppUserByEmail(input.userEmail);
        if (!user) return { success: false, error: 'المستخدم غير موجود' };
        const resolvedUserId = user.id;
        const expiry = calcSubscriptionExpiry(input.plan);
        await db.updateAppUserSubscription(resolvedUserId, input.plan, expiry);
        await db.updatePaymentHistoryStatus(input.recordId, 'success');
        if (user.email) {
          await sendEmail({
            to: user.email,
            subject: 'تم تفعيل اشتراكك — كتاب+',
            html: buildSubscriptionConfirmEmailHtml(
              user.name ?? 'عزيزي المشترك',
              input.plan,
              expiry
            ),
          });
        }
        try {
          const pushToken = await db.getPushTokenByUserId(resolvedUserId);
          if (pushToken) {
            const planLabel = input.plan === 'monthly' ? 'الشهري' : 'السنوي';
            const expiryStr = expiry.toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' });
            await sendSubscriptionActivatedPushNotification(
              pushToken.token,
              user.name ?? 'عزيزي المشترك',
              planLabel,
              expiryStr
            );
            // إشعار ترحيبي للانضمام إلى قناة VIP
            await sendVIPChannelWelcomeNotification(pushToken.token, user.name ?? 'عزيزي المشترك').catch(() => {});
          }
        } catch { /* non-critical */ }
        // نظام الإحالة تم حذفه
        return { success: true, userId: resolvedUserId, plan: input.plan, expiry: expiry.toISOString() };
      }),

    /**
     * جلب طلبات IBAN المعلّقة
     */
    listPendingIban: publicProcedure.query(async () => {
      const records = await db.getPendingIbanPayments(100);
      const results = await Promise.all(records.map(async r => {
        let user = r.userId ? await db.getAppUserById(r.userId) : null;
        if (!user && r.customerEmail) user = await db.getAppUserByEmail(r.customerEmail);
        return {
          id: r.id,
          userId: r.userId,
          userEmail: user?.email ?? r.customerEmail ?? null,
          userName: user?.name ?? (r.customerEmail ? r.customerEmail.split("@")[0] : null),
          userExists: user !== null,
          amount: r.amount,
          currency: r.currency ?? 'SAR',
          plan: r.plan ?? 'monthly',
          referenceId: r.referenceId ?? null,
          status: r.status,
          createdAt: r.createdAt.toISOString()
        };
      }));
      return results;
    }),

    /**
     * تفعيل اشتراك مستخدم بعد التحقق من تحويل IBAN
     */
    activateIbanSubscription: publicProcedure
      .input(z.object({
        recordId: z.number(),
        userId: z.number().nullable().optional(),
        userEmail: z.string().email().optional(),
        plan: z.enum(['monthly', 'yearly']),
      }))
      .mutation(async ({ input }) => {
        // البحث عن المستخدم بالـ userId أولاً، ثم بالبريد الإلكتروني كـ fallback
        let user = input.userId ? await db.getAppUserById(input.userId) : undefined;
        if (!user && input.userEmail) {
          user = await db.getAppUserByEmail(input.userEmail);
        }
        if (!user) return { success: false, error: 'المستخدم غير موجود — تأكد من أن المستخدم مسجّل في التطبيق' };
        const resolvedUserId = user.id; // استخدام id المستخدم الفعلي (user.id) بدلاً من input.userId
        const expiry = calcSubscriptionExpiry(input.plan);
        await db.updateAppUserSubscription(resolvedUserId, input.plan, expiry);
        await db.updatePaymentHistoryStatus(input.recordId, 'success');
        if (user.email) {
          await sendEmail({
            to: user.email,
            subject: 'تم تفعيل اشتراكك — كتاب+',
            html: buildSubscriptionConfirmEmailHtml(
              user.name ?? 'عزيزي المشترك',
              input.plan,
              expiry
            ),
          });
        }
        try {
          const pushToken = await db.getPushTokenByUserId(resolvedUserId);
          if (pushToken) {
            const planLabel = input.plan === 'monthly' ? 'الشهري' : 'السنوي';
            const expiryStr = expiry.toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' });
            await sendSubscriptionActivatedPushNotification(
              pushToken.token,
              user.name ?? 'عزيزي المشترك',
              planLabel,
              expiryStr
            );
            // إشعار ترحيبي للانضمام إلى قناة VIP
            await sendVIPChannelWelcomeNotification(pushToken.token, user.name ?? 'عزيزي المشترك').catch(() => {});
          }
        } catch { /* non-critical */ }
        // نظام الإحالة تم حذفه
        return { success: true, userId: resolvedUserId, plan: input.plan, expiry: expiry.toISOString() };
      }),

    listPendingCrypto: publicProcedure.query(async () => {
      const records = await db.getPendingCryptoPayments(100);
      const results = await Promise.all(records.map(async r => {
        let user = r.userId ? await db.getAppUserById(r.userId) : null;
        if (!user && r.customerEmail) user = await db.getAppUserByEmail(r.customerEmail);
        const userExists = user !== null && user !== undefined;
        return {
          id: r.id,
          userId: r.userId ?? null,
          userEmail: r.customerEmail ?? user?.email ?? '',
          userName: user?.name ?? '?',
          userExists,
          amount: r.amount,
          currency: r.currency,
          plan: r.plan,
          coin: r.cardBrand ?? '',
          txid: r.referenceId ?? '',
          status: r.status,
          createdAt: r.createdAt.toISOString()
        };
      }));
      return results;
    }),

    activateCryptoSubscription: publicProcedure
      .input(z.object({
        recordId: z.number(),
        userId: z.number().nullable().optional(),
        userEmail: z.string().email().optional(),
        plan: z.enum(['monthly', 'yearly']),
      }))
      .mutation(async ({ input }) => {
        let user = input.userId ? await db.getAppUserById(input.userId) : undefined;
        if (!user && input.userEmail) user = await db.getAppUserByEmail(input.userEmail);
        if (!user) return { success: false, error: 'المستخدم غير موجود' };
        const resolvedUserId = user.id;
        const expiry = calcSubscriptionExpiry(input.plan);
        await db.updateAppUserSubscription(resolvedUserId, input.plan, expiry);
        await db.updatePaymentHistoryStatus(input.recordId, 'success');
        if (user.email) {
          await sendEmail({
            to: user.email,
            subject: 'تم تفعيل اشتراكك — كتاب+',
            html: buildSubscriptionConfirmEmailHtml(user.name ?? 'عزيزي المشترك', input.plan, expiry),
          });
        }
        try {
          const pushToken = await db.getPushTokenByUserId(resolvedUserId);
          if (pushToken) {
            const planLabel = input.plan === 'monthly' ? 'الشهري' : 'السنوي';
            const expiryStr = expiry.toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' });
             await sendSubscriptionActivatedPushNotification(pushToken.token, user.name ?? 'عزيزي المشترك', planLabel, expiryStr);
            // إشعار ترحيبي للانضمام إلى قناة VIP
            await sendVIPChannelWelcomeNotification(pushToken.token, user.name ?? 'عزيزي المشترك').catch(() => {});
          }
        } catch { /* non-critical */ }
        // نظام الإحالة تم حذفه
        return { success: true, userId: resolvedUserId, plan: input.plan, expiry: expiry.toISOString() };
      }),
    /**
     * حذف طلب دفع معلّق (للمدير فقط) — يُستخدم عند حذف حساب المستخدم أو طلبات بلا فائدة
     */
    deleteRecord: publicProcedure
      .input(z.object({ recordId: z.number() }))
      .mutation(async ({ input }) => {
        const deleted = await db.deletePaymentHistoryById(input.recordId);
        if (!deleted) return { success: false, error: 'لم يُعثر على السجل أو حدث خطأ أثناء الحذف' };
        return { success: true };
      }),
  }),

  // ── Admin: Users Management ────────────────────────────────────────────────────────────
  adminUsers: router({
    /** جلب جميع المستخدمين */
    list: adminProcedure.query(async () => {
      const users = await db.getAllAppUsers();
      return users.map(u => ({
        id: u.id,
        name: u.name ?? '',
        email: u.email,
        subscriptionPlan: u.subscriptionPlan,
        subscriptionExpiry: u.subscriptionExpiry ? u.subscriptionExpiry.toISOString() : null,
        isAdmin: u.isAdmin,
        createdAt: u.createdAt.toISOString(),
      }));
    }),

    /** إضافة مستخدم يدوياً (بدون OAuth) */
    create: adminProcedure
      .input(z.object({
        name: z.string().min(2),
        email: z.string().email(),
        password: z.string().min(6),
        plan: z.enum(['free', 'monthly', 'yearly', 'trial']).default('free'),
        isAdmin: z.boolean().default(false),
      }))
      .mutation(async ({ input }) => {
        const existing = await db.getAppUserByEmail(input.email);
        if (existing) return { success: false, error: 'البريد الإلكتروني مستخدم بالفعل' };
        const hashed = await hashPassword(input.password);
        const expiry = input.plan !== 'free' ? calcSubscriptionExpiry(input.plan as 'monthly' | 'yearly') : null;
        const id = await db.createAppUser({
          name: input.name,
          email: input.email.toLowerCase(),
          password: hashed,
          subscriptionPlan: input.plan,
          subscriptionExpiry: expiry ?? undefined,
          isAdmin: input.isAdmin ? '1' : '0',
        });
        return { success: true, id };
      }),

    /** تحديث بيانات مستخدم */
    update: adminProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        isAdmin: z.boolean().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...rest } = input;
        const data: { name?: string; email?: string; isAdmin?: '0' | '1' } = {};
        if (rest.name) data.name = rest.name;
        if (rest.email) data.email = rest.email.toLowerCase();
        if (rest.isAdmin !== undefined) data.isAdmin = rest.isAdmin ? '1' : '0';
        await db.updateAppUserProfile(id, data);
        return { success: true };
      }),

    /** تحديث اشتراك مستخدم يدوياً */
    updateSubscription: adminProcedure
      .input(z.object({
        id: z.number(),
        plan: z.enum(['free', 'monthly', 'yearly', 'trial']),
        customExpiry: z.string().optional(), // ISO date string
        isAdmin: z.boolean().optional(), // إذا كان المدير هو من يفعّل
      }))
      .mutation(async ({ input }) => {
        // منع تكرار الخطة التجريبية (إلا إذا كان المدير هو من يفعّل)
        if (input.plan === 'trial' && !input.isAdmin) {
          const history = await db.getPaymentHistoryByUserId(input.id, 100);
          const alreadyUsedTrial = history.some(h => h.plan === 'trial');
          if (alreadyUsedTrial) {
            return { success: false, error: 'لقد استخدمت الخطة التجريبية مسبقاً. يمكنك الاشتراك في الخطة السنوية.' };
          }
        }
        let expiry: Date | null = null;
        if (input.plan !== 'free') {
          expiry = input.customExpiry
            ? new Date(input.customExpiry)
            : calcSubscriptionExpiry(input.plan as 'monthly' | 'yearly' | 'trial');
        }
        await db.updateAppUserSubscription(input.id, input.plan, expiry);
        // تسجيل الخطة التجريبية في سجل الدفع (لمنع التكرار)
        if (input.plan === 'trial') {
          try {
            const user = await db.getAppUserById(input.id);
            await db.insertPaymentHistory({
              userId: input.id,
              customerEmail: user?.email ?? null,
              gateway: 'free',
              chargeId: `trial_${Date.now()}`,
              amount: 0,
              currency: 'USD',
              plan: 'trial',
              status: 'success',
              referenceId: `trial_${input.id}_${Date.now()}`,
            });
          } catch { /* non-critical */ }
        }
        // إرسال بريد + Push Notification إذا تم تفعيل اشتراك حقيقي
        if (input.plan !== 'free' && expiry) {
          const user = await db.getAppUserById(input.id);
          if (user?.email) {
            // إرسال بريد تأكيد (بشكل غير متزامن)
            sendEmail({
              to: user.email,
              subject: 'تم تفعيل اشتراكك — كتاب+',
              html: buildSubscriptionConfirmEmailHtml(user.name, input.plan, expiry),
            }).catch(() => { /* لا نوقف عند فشل البريد */ });
            // إرسال Push Notification إن كان لديه token
            const pushToken = await db.getPushTokenByUserId(input.id);
            if (pushToken?.token) {
              const expiryDateStr = expiry.toLocaleDateString('ar-SA', { year: 'numeric', month: 'long', day: 'numeric' });
              sendSubscriptionUpdatedPushNotification(
                pushToken.token,
                user.name ?? 'عزيزي',
                input.plan,
                expiryDateStr
              ).catch(() => { /* لا نوقف عند فشل Push */ });
            }
          }
        }
        return { success: true };
      }),

    /** تغيير كلمة مرور مستخدم */
    resetPassword: adminProcedure
      .input(z.object({ id: z.number(), newPassword: z.string().min(6) }))
      .mutation(async ({ input }) => {
        const hashed = await hashPassword(input.newPassword);
        await db.updateAppUserPassword(input.id, hashed);
        return { success: true };
      }),

    /** حذف مستخدم */
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteAppUser(input.id);
        return { success: true };
      }),

    /** إرسال تذكير تجديد اشتراك يدوياً لمستخدم محدد (بريد + push) */
    sendRenewalReminder: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const user = await db.getAppUserById(input.id);
        if (!user?.email) return { success: false, error: 'المستخدم غير موجود' };
        if (!user.subscriptionExpiry) return { success: false, error: 'لا يوجد اشتراك نشط' };
        const daysLeft = Math.ceil((user.subscriptionExpiry.getTime() - Date.now()) / 86400000);
        // إرسال بريد تذكير
        await sendEmail({
          to: user.email,
          subject: `تذكير: اشتراكك ينتهي خلال ${daysLeft} يوم — كتاب+`,
          html: buildRenewalReminderEmailHtml(user.name, daysLeft, user.subscriptionExpiry),
        });
        // إرسال Push Notification إن كان لديه token
        const pushToken = await db.getPushTokenByUserId(input.id);
        if (pushToken) {
          await sendRenewalPushNotification(pushToken.token, user.name ?? 'عزيزي', daysLeft).catch(() => {});
        }
        return { success: true };
      }),
  }),

  // ── Push Tokens ────────────────────────────────────────────────────────────
  pushToken: router({
    /** حفظ Push Token للمستخدم */
    register: publicProcedure
      .input(z.object({
        userId: z.number(),
        token: z.string().min(1),
        platform: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        await db.upsertPushToken(input.userId, input.token, input.platform);
        return { success: true };
      }),
    /** حذف Push Token عند تسجيل الخروج */
    unregister: publicProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input }) => {
        await db.deletePushToken(input.userId);
        return { success: true };
      }),
  }),

  // ── App Update Check ─────────────────────────────────────────────────────────
  appUpdate: router({
    /**
     * التحقق من توفر تحديث جديد للتطبيق
     * يُرجع معلومات الإصدار الأحدث ورابط التنزيل
     */
    check: publicProcedure
      .input(z.object({
        currentVersion: z.string(), // مثال: "1.0.20"
      }))
      .query(async ({ input }) => {
        // ── جلب آخر إصدار تلقائياً من GitHub Releases API ──
        const GITHUB_REPO = "mrmsd76-lang/kitabplus-releases";
        const FORCE_UPDATE = false; // true = لا يمكن تخطي التحديث

        let LATEST_VERSION = "1.0.23"; // قيمة احتياطية
        let DOWNLOAD_URL = `https://github.com/${GITHUB_REPO}/releases/download/v${LATEST_VERSION}/kitabplus-v${LATEST_VERSION}.apk`;
        let RELEASE_NOTES_AR = "تحديث جديد - إصلاحات وتحسينات عامة";
        let RELEASE_NOTES_EN = "New update - fixes and general improvements";

        try {
          const ghRes = await fetch(
            `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
            { headers: { 'User-Agent': 'KitabPlus-Server', 'Accept': 'application/vnd.github.v3+json' } }
          );
          if (ghRes.ok) {
            const release = await ghRes.json() as {
              tag_name: string;
              body?: string;
              assets?: { name: string; browser_download_url: string }[];
            };
            // استخراج رقم الإصدار من tag مثل "v1.0.26" → "1.0.26"
            LATEST_VERSION = release.tag_name.replace(/^v/, '');
            // البحث عن ملف APK في assets
            const apkAsset = (release.assets ?? []).find(a => a.name.endsWith('.apk'));
            if (apkAsset) {
              DOWNLOAD_URL = apkAsset.browser_download_url;
            } else {
              DOWNLOAD_URL = `https://github.com/${GITHUB_REPO}/releases/download/${release.tag_name}/kitabplus-${release.tag_name}.apk`;
            }
            // استخراج ملاحظات الإصدار (أول سطرين)
            if (release.body) {
              const lines = release.body.split('\n').filter(l => l.trim()).slice(0, 2);
              RELEASE_NOTES_AR = lines[0] ?? RELEASE_NOTES_AR;
              RELEASE_NOTES_EN = lines[1] ?? RELEASE_NOTES_EN;
            }
          }
        } catch {
          // استخدام القيم الاحتياطية عند فشل الاتصال
        }
        // ─────────────────────────────────────────────────────────────────────

        // مقارنة الإصدارات برقمياً
        // تدعم صيغ مختلفة: "1.0.29" أو "1_0_29" أو "v1_0_29"
        const parseVersion = (v: string) =>
          v.replace(/^v/, '').replace(/_/g, '.').replace(/[^0-9.]/g, '').split('.').map(Number);

        const current = parseVersion(input.currentVersion);
        const latest = parseVersion(LATEST_VERSION);

        let hasUpdate = false;
        for (let i = 0; i < Math.max(current.length, latest.length); i++) {
          const c = current[i] ?? 0;
          const l = latest[i] ?? 0;
          if (l > c) { hasUpdate = true; break; }
          if (l < c) { break; }
        }

        return {
          hasUpdate,
          latestVersion: LATEST_VERSION,
          downloadUrl: DOWNLOAD_URL,
          releaseNotesAr: RELEASE_NOTES_AR,
          releaseNotesEn: RELEASE_NOTES_EN,
          forceUpdate: FORCE_UPDATE,
        };
      }),
  }),

  // ── App Installs / First Opens ───────────────────────────────────────────────────────────────────
  installs: router({
    /** تسجيل فتح التطبيق — يُستدعى مرة واحدة عند أول تشغيل */
    record: publicProcedure
      .input((v: unknown) => {
        const d = v as { deviceId: string; appVersion?: string; platform?: string; deviceModel?: string; country?: string };
        if (!d?.deviceId) throw new Error('deviceId required');
        return d;
      })
      .mutation(async ({ input }) => {
        await db.recordAppInstall({
          deviceId: input.deviceId,
          appVersion: input.appVersion ?? null,
          platform: input.platform ?? null,
          deviceModel: input.deviceModel ?? null,
          country: input.country ?? null,
        });
        return { ok: true };
      }),

    /** جلب إحصائيات التنزيلات — للمدير فقط */
    stats: publicProcedure
      .input((v: unknown) => {
        const d = v as { period?: string } | undefined;
        return { period: d?.period ?? 'all' };
      })
      .query(async ({ input }) => {
        let sinceDate: Date | undefined;
        const now = new Date();
        if (input.period === '7d') {
          sinceDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        } else if (input.period === '30d') {
          sinceDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        } else if (input.period === '90d') {
          sinceDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        }
        return db.getInstallStats(sinceDate);
      }),
   }),

  // ── Admin: Broadcast Notifications ───────────────────────────────────────────────────
  adminNotifications: router({
    /** إرسال إشعار Push جماعي لجميع المشتركين عند إضافة كتاب جديد */
    notifyNewBook: publicProcedure
      .input(z.object({
        bookTitle: z.string().min(1),
        authorName: z.string().min(1),
        category: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const result = await sendNewBookPushNotification(
          input.bookTitle,
          input.authorName,
          input.category
        );
        return { success: true, sent: result.sent, errors: result.errors };
      }),
  }),

  // ── Admin: Book Suggestions ────────────────────────────────────────────────────────────
  adminSuggestions: router({
    /** جلب اقتراحات الكتب من جميع المستخدمين */
    list: publicProcedure.query(async () => {
      const users = await db.getAllAppUsers();
      const result: Array<{
        suggestionId: string;
        userId: number;
        userName: string;
        userEmail: string;
        bookTitle: string;
        author: string;
        reason: string;
        submittedAt: string;
        status: string;
      }> = [];
      for (const user of users) {
        const suggestions = (user as any).bookSuggestions as Array<{
          id: string;
          bookTitle: string;
          author: string;
          reason: string;
          submittedAt: string;
          status: string;
        }> | undefined;
        if (!suggestions || !Array.isArray(suggestions)) continue;
        for (const s of suggestions) {
          result.push({
            suggestionId: s.id,
            userId: user.id,
            userName: user.name ?? '',
            userEmail: user.email,
            bookTitle: s.bookTitle,
            author: s.author,
            reason: s.reason ?? '',
            submittedAt: s.submittedAt,
            status: s.status ?? 'pending',
          });
        }
      }
      // ترتيب من الأحدث للأقدم
      result.sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
      return result;
    }),

    /** تحديث حالة اقتراح معين */
    updateStatus: publicProcedure
      .input(z.object({
        userEmail: z.string().email(),
        suggestionId: z.string(),
        status: z.enum(['pending', 'approved', 'rejected']),
      }))
      .mutation(async ({ input }) => {
        // جلب بيانات المستخدم
        const user = await db.getAppUserByEmail(input.userEmail);
        if (!user) return { success: false, error: 'المستخدم غير موجود' };
        const suggestions = (user as any).bookSuggestions as Array<{
          id: string;
          bookTitle: string;
          author: string;
          reason: string;
          submittedAt: string;
          status: string;
        }> | undefined;
        if (!suggestions || !Array.isArray(suggestions)) return { success: false, error: 'لا توجد اقتراحات' };
        const updated = suggestions.map(s =>
          s.id === input.suggestionId ? { ...s, status: input.status } : s
        );
        // تحديث في Supabase عبر db layer
        await db.updateBookSuggestions(user.id, updated);
        // إرسال Push Notification للمستخدم عند تغيير الحالة إلى approved أو rejected
        if (input.status === 'approved' || input.status === 'rejected') {
          const targetSuggestion = suggestions.find(s => s.id === input.suggestionId);
          if (targetSuggestion) {
            const pushToken = await db.getPushTokenByUserId(user.id);
            if (pushToken?.token) {
              sendBookSuggestionStatusPushNotification(
                pushToken.token,
                user.name ?? 'عزيزي',
                targetSuggestion.bookTitle,
                input.status
              ).catch(() => { /* لا نوقف عند فشل Push */ });
            }
          }
        }
        return { success: true };
      }),
  }),

  // نظام الإحالة تم حذفه

  // ── Admin Comments Management ─────────────────────────────────────────────
  adminComments: router({
    /**
     * حذف تعليق مع إرسال إشعار Push للمستخدم بسبب المخالفة
     */
    deleteWithNotification: publicProcedure
      .input(z.object({
        commentId: z.string(),
        userEmail: z.string().email(),
        userName: z.string(),
        reason: z.string(),
      }))
      .mutation(async ({ ctx, input }) => {
        // التحقق من صلاحيات المدير
        const admin = ctx.user;
        if (!admin || (admin as any).isAdmin !== '1') throw new Error('غير مصرح');

        // إرسال إشعار Push للمستخدم قبل الحذف
        try {
          const user = await db.getAppUserByEmail(input.userEmail);
          if (user) {
            const pushToken = await db.getPushTokenByUserId(user.id);
            if (pushToken?.token) {
              await sendCommentDeletedPushNotification(
                pushToken.token,
                input.userName,
                input.reason
              );
              console.log(`[AdminComments] Push sent to ${input.userEmail} for comment deletion`);
            }
          }
        } catch (pushErr) {
          console.warn('[AdminComments] Push notification failed:', pushErr);
        }

        return { success: true };
      }),
  }),
  // ═══ userData: Server-side writes that bypass RLS ═══
  userData: router({
    addComment: publicProcedure
      .input(z.object({
        id: z.string(),
        book_id: z.string(),
        user_email: z.string(),
        user_name: z.string(),
        text: z.string(),
        timestamp: z.number(),
        reply_to: z.string().nullable().optional(),
      }))
      .mutation(async ({ input }) => {
        return { success: await sbData.addComment(input) };
      }),
    deleteComment: publicProcedure
      .input(z.object({ commentId: z.string() }))
      .mutation(async ({ input }) => {
        return { success: await sbData.deleteComment(input.commentId) };
      }),
    toggleCommentLike: publicProcedure
      .input(z.object({ commentId: z.string(), userEmail: z.string() }))
      .mutation(async ({ input }) => {
        return { success: await sbData.toggleCommentLike(input.commentId, input.userEmail) };
      }),
    reportComment: publicProcedure
      .input(z.object({ commentId: z.string(), userEmail: z.string() }))
      .mutation(async ({ input }) => {
        return { success: await sbData.reportComment(input.commentId, input.userEmail) };
      }),
    toggleHideComment: publicProcedure
      .input(z.object({ commentId: z.string(), currentHidden: z.boolean() }))
      .mutation(async ({ input }) => {
        return { success: await sbData.toggleHideComment(input.commentId, input.currentHidden) };
      }),
    rateBook: publicProcedure
      .input(z.object({ bookId: z.string(), userEmail: z.string(), rating: z.number() }))
      .mutation(async ({ input }) => {
        return { success: await sbData.rateBook(input.bookId, input.userEmail, input.rating) };
      }),
    upsertReview: publicProcedure
      .input(z.object({
        id: z.string(),
        book_id: z.string(),
        user_email: z.string(),
        user_name: z.string(),
        strengths: z.string(),
        weaknesses: z.string(),
        conclusion: z.string(),
        rating: z.number(),
      }))
      .mutation(async ({ input }) => {
        return { success: await sbData.upsertReview(input) };
      }),
    deleteReview: publicProcedure
      .input(z.object({ reviewId: z.string() }))
      .mutation(async ({ input }) => {
        return { success: await sbData.deleteReview(input.reviewId) };
      }),
    toggleReviewLike: publicProcedure
      .input(z.object({ reviewId: z.string(), userEmail: z.string() }))
      .mutation(async ({ input }) => {
        return { success: await sbData.toggleReviewLike(input.reviewId, input.userEmail) };
      }),
    reportReview: publicProcedure
      .input(z.object({ reviewId: z.string(), userEmail: z.string() }))
      .mutation(async ({ input }) => {
        return { success: await sbData.reportReview(input.reviewId, input.userEmail) };
      }),
    toggleHideReview: publicProcedure
      .input(z.object({ reviewId: z.string(), currentlyHidden: z.boolean() }))
      .mutation(async ({ input }) => {
        return { success: await sbData.toggleHideReview(input.reviewId, input.currentlyHidden) };
      }),
    updateFields: publicProcedure
      .input(z.object({
        email: z.string(),
        fields: z.record(z.string(), z.any()),
      }))
      .mutation(async ({ input }) => {
        return { success: await sbData.updateUserData(input.email, input.fields) };
      }),
  }),
});
export type AppRouter = typeof appRouter;

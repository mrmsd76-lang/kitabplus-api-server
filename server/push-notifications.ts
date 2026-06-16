/**
 * push-notifications.ts
 * خدمة إرسال Push Notifications عبر Expo Push Service
 * تعمل جنباً إلى جنب مع خدمة البريد الإلكتروني لتذكير تجديد الاشتراك
 */

import * as db from "./db";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const REMINDER_DAYS = [7, 3, 1];

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  badge?: number;
  priority?: "default" | "normal" | "high";
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * إرسال Push Notification واحد عبر Expo Push Service
 */
export async function sendPushNotification(message: ExpoPushMessage): Promise<ExpoPushTicket> {
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(message),
    });
    const json = (await res.json()) as { data?: ExpoPushTicket };
    return json.data ?? { status: "error", message: "No response data" };
  } catch (err) {
    return { status: "error", message: String(err) };
  }
}

/**
 * إرسال Push Notifications لمجموعة من المستخدمين (batch)
 */
export async function sendBatchPushNotifications(
  messages: ExpoPushMessage[]
): Promise<ExpoPushTicket[]> {
  if (messages.length === 0) return [];
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(messages),
    });
    const json = (await res.json()) as { data?: ExpoPushTicket[] };
    return json.data ?? [];
  } catch (err) {
    console.error("[push] فشل إرسال batch:", err);
    return [];
  }
}

/**
 * إرسال إشعار تذكير تجديد الاشتراك لمستخدم محدد
 */
export async function sendRenewalPushNotification(
  token: string,
  userName: string,
  daysLeft: number
): Promise<ExpoPushTicket> {
  const urgencyEmoji = daysLeft <= 1 ? "🚨" : daysLeft <= 3 ? "⚠️" : "📅";
  const title =
    daysLeft <= 1
      ? "🚨 اشتراكك ينتهي غداً!"
      : daysLeft <= 3
      ? `⚠️ اشتراكك ينتهي خلال ${daysLeft} أيام`
      : `📅 تذكير: اشتراكك ينتهي خلال ${daysLeft} أيام`;

  const body =
    daysLeft <= 1
      ? "جدّد اشتراكك الآن لتحافظ على وصولك لجميع الكتب"
      : `مرحباً ${userName}، لا تفوّت فرصة الاستمرار في رحلتك المعرفية`;

  return sendPushNotification({
    to: token,
    title,
    body,
    sound: "default",
    priority: daysLeft <= 3 ? "high" : "default",
    data: {
      type: "subscription_renewal",
      daysLeft,
      screen: "/subscription",
    },
  });
}

/**
 * فحص المشتركين الذين يقترب انتهاء اشتراكهم وإرسال Push Notifications
 */
export async function sendRenewalPushNotifications(): Promise<{
  checked: number;
  sent: number;
  errors: number;
}> {
  let sent = 0;
  let errors = 0;
  let checked = 0;

  try {
    for (const days of REMINDER_DAYS) {
      const users = await db.getPushTokensForExpiringUsers(days);
      // فلترة المستخدمين الذين تبقى لهم بالضبط N يوم
      const exactDay = users.filter(u => {
        const daysLeft = Math.ceil(
          (u.subscriptionExpiry.getTime() - Date.now()) / 86400000
        );
        return daysLeft === days;
      });

      checked += exactDay.length;

      if (exactDay.length === 0) continue;

      const messages: ExpoPushMessage[] = exactDay.map(u => ({
        to: u.token,
        title:
          days <= 1
            ? "🚨 اشتراكك ينتهي غداً!"
            : days <= 3
            ? `⚠️ اشتراكك ينتهي خلال ${days} أيام`
            : `📅 تذكير: اشتراكك ينتهي خلال ${days} أيام`,
        body:
          days <= 1
            ? "جدّد اشتراكك الآن لتحافظ على وصولك لجميع الكتب"
            : `مرحباً ${u.name}، لا تفوّت فرصة الاستمرار في رحلتك المعرفية`,
        sound: "default",
        priority: days <= 3 ? "high" : "default",
        data: { type: "subscription_renewal", daysLeft: days, screen: "/subscription" },
      }));

      const tickets = await sendBatchPushNotifications(messages);
      for (const ticket of tickets) {
        if (ticket.status === "ok") {
          sent++;
        } else {
          errors++;
          console.error(`[push] خطأ في إرسال إشعار:`, ticket.message);
        }
      }

      console.log(
        `[push] ${days} أيام: ${exactDay.length} مستخدم، ${tickets.filter(t => t.status === "ok").length} أُرسل`
      );
    }
  } catch (err) {
    console.error("[push] خطأ عام:", err);
    errors++;
  }

  return { checked, sent, errors };
}

/**
 * تشغيل جدولة Push Notifications التلقائية (يومياً الساعة 9 صباحاً)
 */
export function startPushNotificationScheduler(): void {
  function msUntilNextRun(): number {
    const now = new Date();
    const next = new Date(now);
    next.setHours(9, 5, 0, 0); // 9:05 صباحاً (بعد 5 دقائق من تذكير البريد)
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now.getTime();
  }

  function scheduleNext() {
    const delay = msUntilNextRun();
    const nextRunTime = new Date(Date.now() + delay);
    console.log(
      `[push-scheduler] الجدولة التالية: ${nextRunTime.toLocaleString("ar-SA")}`
    );

    setTimeout(async () => {
      const result = await sendRenewalPushNotifications();
      console.log(
        `[push-scheduler] اكتمل: ${result.checked} فُحص، ${result.sent} أُرسل، ${result.errors} خطأ`
      );
      // جدولة التشغيل التالي (24 ساعة)
      setInterval(async () => {
        const r = await sendRenewalPushNotifications();
        console.log(
          `[push-scheduler] اكتمل: ${r.checked} فُحص، ${r.sent} أُرسل، ${r.errors} خطأ`
        );
      }, 24 * 60 * 60 * 1000);
    }, delay);
  }

  scheduleNext();
  console.log("[push-scheduler] ✅ خدمة Push Notifications التلقائية تعمل");
}

/**
 * إرسال إشعار جماعي لجميع المشتركين عند إضافة كتاب جديد للمكتبة
 */
export async function sendNewBookPushNotification(
  bookTitle: string,
  authorName: string,
  category?: string
): Promise<{ sent: number; errors: number }> {
  const subscribers = await db.getAllSubscriberPushTokens();
  if (subscribers.length === 0) return { sent: 0, errors: 0 };

  const categoryLabel = category ? ` • ${category}` : '';
  const messages: ExpoPushMessage[] = subscribers.map(s => ({
    to: s.token,
    title: '📚 كتاب جديد أضيف للمكتبة!',
    body: `مرحباً ${s.name}، تم إضافة كتاب “${bookTitle}” لـ ${authorName}${categoryLabel}. افتح التطبيق واكتشفه الآن!`,
    sound: 'default',
    priority: 'high',
    data: {
      type: 'new_book',
      bookTitle,
      authorName,
      screen: '/(tabs)',
    },
  }));

  // إرسال على دفعات بحد أقصى 100 رسالة لتجنب تجاوز حدود Expo
  const BATCH_SIZE = 100;
  let sent = 0;
  let errors = 0;

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const tickets = await sendBatchPushNotifications(batch);
    for (const ticket of tickets) {
      if (ticket.status === 'ok') sent++;
      else {
        errors++;
        console.error('[push:newBook] خطأ:', ticket.message);
      }
    }
  }

  console.log(`[push:newBook] أرسل إشعار “${bookTitle}” لـ ${sent} مشترك، أخطاء: ${errors}`);
  return { sent, errors };
}

/**
 * إرسال إشعار عند تغيير حالة اقتراح كتاب من لوحة الإدارة
 */
export async function sendBookSuggestionStatusPushNotification(
  token: string,
  userName: string,
  bookTitle: string,
  status: "approved" | "rejected"
): Promise<ExpoPushTicket> {
  const isApproved = status === "approved";
  const title = isApproved
    ? "✅ تمت إضافة كتابك المقترح!"
    : "📋 تحديث حول اقتراحك";
  const body = isApproved
    ? `مرحباً ${userName}، تمت إضافة كتاب "${bookTitle}" الذي اقترحته إلى المكتبة. شكراً لمساهمتك!`
    : `مرحباً ${userName}، بعد المراجعة لم نتمكن من إضافة كتاب "${bookTitle}" في الوقت الحالي. نقدّر اقتراحك!`;

  return sendPushNotification({
    to: token,
    title,
    body,
    sound: "default",
    priority: "high",
    data: {
      type: "book_suggestion_status",
      bookTitle,
      status,
      screen: "/(tabs)/profile",
    },
  });
}

/**
 * إرسال إشعار عند تحديث الاشتراك يدوياً من لوحة الإدارة
 */
export async function sendSubscriptionUpdatedPushNotification(
  token: string,
  userName: string,
  planName: string,
  expiryDate: string
): Promise<ExpoPushTicket> {
  const planLabel = planName === "monthly" ? "الشهري" : planName === "yearly" ? "السنوي" : planName === "trial" ? "التجريبي (24 ساعة)" : planName;
  return sendPushNotification({
    to: token,
    title: "🎉 تم تحديث اشتراكك!",
    body: `مرحباً ${userName}، تم تجديد اشتراكك ${planLabel} بنجاح وهو فعّال حتى ${expiryDate}. استمتع بجميع الكتب الآن!`,
    sound: "default",
    priority: "high",
    data: {
      type: "subscription_updated",
      planName,
      expiryDate,
      screen: "/(tabs)/profile",
    },
  });
}

/**
 * إرسال إشعار للمدير عند وصول طلب دفع جديد
 */
export async function sendAdminNewPaymentPushNotification(
  gateway: string,
  customerName: string,
  customerEmail: string,
  plan: string,
  amountDisplay: string
): Promise<void> {
  try {
    const adminTokens = await db.getAdminPushTokens();
    if (adminTokens.length === 0) return;
    const gatewayLabel: Record<string, string> = {
      stcpay: 'STC Pay 📱',
      paypal: 'PayPal 🅿️',
      wise: 'Wise 🟢',
      iban: 'IBAN 🏦',
    };
    const planLabel = plan === 'monthly' ? 'شهري' : plan === 'yearly' ? 'سنوي' : plan === 'trial' ? 'تجريبي' : plan;
    const messages: ExpoPushMessage[] = adminTokens.map(a => ({
      to: a.token,
      title: `💳 طلب ${gatewayLabel[gateway] ?? gateway} جديد`,
      body: `${customerName} (${customerEmail}) — خطة ${planLabel} • ${amountDisplay}`,
      sound: 'default',
      priority: 'high',
      data: { type: 'admin_new_payment', gateway, customerEmail, screen: '/(tabs)/profile' },
    }));
    await sendBatchPushNotifications(messages);
    console.log(`[push:admin] إشعار طلب ${gateway} أُرسل لـ ${adminTokens.length} مدير`);
  } catch (err) {
    console.warn('[push:admin] فشل إرسال إشعار المدير:', err);
  }
}



/**
 * إرسال إشعار تأكيد تفعيل الاشتراك للمستخدم
 */
export async function sendSubscriptionActivatedPushNotification(
  token: string,
  userName: string,
  planName: string,
  expiryDate: string
): Promise<ExpoPushTicket> {
  return sendPushNotification({
    to: token,
    title: "🎉 تم تفعيل اشتراكك بنجاح!",
    body: `مرحباً ${userName}، اشتراكك في خطة "${planName}" فعّال حتى ${expiryDate}. استمتع بجميع الكتب الآن!`,
    sound: "default",
    priority: "high",
    data: {
      type: "subscription_activated",
      planName,
      expiryDate,
      screen: "/(tabs)",
    },
  });
}

/**
 * إرسال إشعار للمستخدم عند حذف تعليقه بسبب مخالفة القواعد
 */
export async function sendCommentDeletedPushNotification(
  token: string,
  userName: string,
  reason: string
): Promise<ExpoPushTicket> {
  return sendPushNotification({
    to: token,
    title: "⚠️ تم حذف تعليقك",
    body: `مرحباً ${userName}، تم حذف أحد تعليقاتك بسبب: ${reason}. يرجى الالتزام بقواعد المجتمع.`,
    sound: "default",
    priority: "high",
    data: {
      type: "comment_deleted",
      reason,
      screen: "/(tabs)",
    },
  });
}

/**
 * إشعار ترحيبي للانضمام إلى قناة VIP على تيليغرام
 * يُرسل مرة واحدة فقط عند تفعيل الاشتراك لأول مرة
 */
export async function sendVIPChannelWelcomeNotification(
  token: string,
  userName: string
): Promise<ExpoPushTicket> {
  return sendPushNotification({
    to: token,
    title: "✨ مرحباً في مجتمع كتاب+ VIP!",
    body: `أهلاً ${userName}! انضم الآن إلى قناة VIP الحصرية على تيليغرام واستمتع بمحتوى مميز 📚`,
    sound: "default",
    priority: "high",
    data: {
      type: "vip_channel_invite",
      telegramUrl: "https://t.me/KitabPlusVIP",
      screen: "/(tabs)/profile",
    },
  });
}

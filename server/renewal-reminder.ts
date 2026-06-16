/**
 * renewal-reminder.ts
 * خدمة تذكير تجديد الاشتراك تلقائياً
 * تعمل كل يوم وترسل بريداً للمشتركين الذين ينتهي اشتراكهم خلال 7 أيام أو 3 أيام أو 1 يوم
 */

import { sendEmail, buildRenewalReminderEmailHtml } from "./_core/email";
import * as db from "./db";

const REMINDER_DAYS = [7, 3, 1]; // أيام الإرسال قبل الانتهاء

/**
 * فحص المشتركين الذين يقترب انتهاء اشتراكهم وإرسال تذكيرات
 */
export async function sendRenewalReminders(): Promise<{
  checked: number;
  sent: number;
  errors: number;
}> {
  let sent = 0;
  let errors = 0;

  try {
    const users = await db.getAllAppUsers();
    const now = Date.now();

    const eligibleUsers = users.filter(u => {
      if (!u.subscriptionExpiry || u.subscriptionPlan === "free") return false;
      const daysLeft = Math.ceil((u.subscriptionExpiry.getTime() - now) / 86400000);
      return REMINDER_DAYS.includes(daysLeft);
    });

    for (const user of eligibleUsers) {
      if (!user.email || !user.subscriptionExpiry) continue;
      const daysLeft = Math.ceil((user.subscriptionExpiry.getTime() - now) / 86400000);
      try {
        await sendEmail({
          to: user.email,
          subject: `تذكير: اشتراكك ينتهي خلال ${daysLeft} يوم — كتاب+`,
          html: buildRenewalReminderEmailHtml(
            user.name ?? "عزيزي المشترك",
            daysLeft,
            user.subscriptionExpiry
          ),
        });
        sent++;
        console.log(`[renewal-reminder] ✅ أُرسل تذكير إلى ${user.email} (${daysLeft} يوم متبقي)`);
      } catch (err) {
        errors++;
        console.error(`[renewal-reminder] ❌ فشل إرسال تذكير إلى ${user.email}:`, err);
      }
    }

    console.log(
      `[renewal-reminder] اكتمل الفحص: ${users.length} مستخدم، ${eligibleUsers.length} مؤهل، ${sent} أُرسل، ${errors} خطأ`
    );

    return { checked: users.length, sent, errors };
  } catch (err) {
    console.error("[renewal-reminder] خطأ عام:", err);
    return { checked: 0, sent, errors: errors + 1 };
  }
}

/**
 * تشغيل خدمة التذكير التلقائي (يومياً في الساعة 9 صباحاً)
 */
export function startRenewalReminderScheduler(): void {
  // حساب الوقت حتى الساعة 9 صباحاً القادمة
  function msUntilNextRun(): number {
    const now = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now.getTime();
  }

  function scheduleNext() {
    const delay = msUntilNextRun();
    const nextRunTime = new Date(Date.now() + delay);
    console.log(
      `[renewal-reminder] الجدولة التالية: ${nextRunTime.toLocaleString("ar-SA")}`
    );

    setTimeout(async () => {
      await sendRenewalReminders();
      // جدولة التشغيل التالي (24 ساعة)
      setInterval(async () => {
        await sendRenewalReminders();
      }, 24 * 60 * 60 * 1000);
    }, delay);
  }

  scheduleNext();
  console.log("[renewal-reminder] ✅ خدمة تذكير التجديد التلقائي تعمل");
}

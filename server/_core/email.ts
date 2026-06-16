/**
 * ============================================================
 *  email.ts — مساعد إرسال البريد الإلكتروني عبر Resend API
 * ============================================================
 *
 *  الاستخدام:
 *  ─────────────────────────────────────────────────────────
 *  import { sendEmail } from "./_core/email";
 *
 *  await sendEmail({
 *    to: "user@example.com",
 *    subject: "رمز التحقق",
 *    html: "<p>رمزك: <strong>123456</strong></p>",
 *  });
 *
 *  ملاحظات:
 *  ─────────────────────────────────────────────────────────
 *  - في وضع الاختبار (بدون نطاق موثّق): يُرسل فقط إلى البريد
 *    المسجّل في حساب Resend (صاحب المفتاح).
 *  - لإرسال لأي بريد: وثّق نطاقاً في resend.com/domains
 *    وعيّن EMAIL_FROM=noreply@yourdomain.com في المتغيرات.
 * ============================================================
 */

import { ENV } from "./env";
export { buildSubscriptionConfirmEmailHtml, buildRenewalReminderEmailHtml, buildPaymentReceiptEmailHtml } from "./email-subscription";

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface SendEmailResult {
  success: boolean;
  id?: string;
  error?: string;
}

/**
 * يُرسل بريداً إلكترونياً عبر Resend API.
 * يُعيد { success: true, id } عند النجاح أو { success: false, error } عند الفشل.
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const { to, subject, html, text } = options;

  if (!ENV.resendApiKey) {
    console.warn("[Email] RESEND_API_KEY is not configured — skipping email send");
    return { success: false, error: "Email service not configured" };
  }

  const body: Record<string, unknown> = {
    from: ENV.emailFrom,
    to: [to],
    subject,
    html,
  };

  if (text) {
    body.text = text;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ENV.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      const errMsg = (data.message as string) || `HTTP ${res.status}`;
      console.error(`[Email] Failed to send email to ${to}: ${errMsg}`);
      return { success: false, error: errMsg };
    }

    console.log(`[Email] Sent to ${to} (id: ${data.id})`);
    return { success: true, id: data.id as string };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[Email] Error sending email:`, errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * قالب HTML لبريد رمز استعادة كلمة المرور
 */
export function buildPasswordResetEmailHtml(code: string, appName = "كتاب+"): string {
  return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>رمز استعادة كلمة المرور</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif;direction:rtl;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="500" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:#1A2A3A;padding:32px 40px;text-align:center;">
              <h1 style="color:#D4AF37;margin:0;font-size:28px;font-weight:bold;">📚 ${appName}</h1>
              <p style="color:#9BA1A6;margin:8px 0 0;font-size:14px;">المعرفة في متناول يدك</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <h2 style="color:#1A2A3A;margin:0 0 16px;font-size:22px;">استعادة كلمة المرور</h2>
              <p style="color:#687076;margin:0 0 24px;font-size:15px;line-height:1.6;">
                تلقّينا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك. استخدم الرمز أدناه لإتمام العملية:
              </p>
              <!-- Code Box -->
              <div style="background:#F0F4FF;border:2px dashed #D4AF37;border-radius:12px;padding:24px;text-align:center;margin:0 0 24px;">
                <p style="margin:0 0 8px;color:#687076;font-size:13px;">رمز التحقق</p>
                <p style="margin:0;color:#1A2A3A;font-size:40px;font-weight:bold;letter-spacing:12px;">${code}</p>
                <p style="margin:8px 0 0;color:#EF4444;font-size:12px;">⏱ صالح لمدة 15 دقيقة فقط</p>
              </div>
              <p style="color:#687076;margin:0 0 16px;font-size:14px;line-height:1.6;">
                إذا لم تطلب إعادة تعيين كلمة المرور، يمكنك تجاهل هذا البريد بأمان. حسابك لا يزال محمياً.
              </p>
              <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0;">
              <p style="color:#9BA1A6;margin:0;font-size:12px;text-align:center;">
                هذا البريد أُرسل تلقائياً من ${appName}. يرجى عدم الرد عليه.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * قالب بريد الترحيب للمستخدمين الجدد
 */
export function buildWelcomeEmailHtml(name: string, appName = "كتاب+"): string {
  return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>مرحباً بك في ${appName}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif;direction:rtl;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="500" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#1A2A3A 0%,#2C3E50 100%);padding:40px;text-align:center;">
              <div style="font-size:48px;margin-bottom:12px;">📚</div>
              <h1 style="color:#D4AF37;margin:0;font-size:30px;font-weight:bold;">${appName}</h1>
              <p style="color:#9BA1A6;margin:8px 0 0;font-size:14px;letter-spacing:1px;">المعرفة في متناول يدك</p>
            </td>
          </tr>
          <tr>
            <td style="background:#D4AF37;padding:16px 40px;text-align:center;">
              <p style="margin:0;color:#1A2A3A;font-size:16px;font-weight:bold;">🎉 أهلاً وسهلاً بك في عائلة القرّاء!</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h2 style="color:#1A2A3A;margin:0 0 12px;font-size:22px;">مرحباً، ${name}!</h2>
              <p style="color:#687076;margin:0 0 24px;font-size:15px;line-height:1.8;">
                يسعدنا انضمامك إلى <strong style="color:#1A2A3A;">${appName}</strong> — منصّتك الشاملة لملخصات الكتب وتحديات القراءة. أنت الآن جزء من مجتمع يؤمن بأن القراءة هي أقصر الطرق إلى النجاح.
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                <tr>
                  <td style="padding:12px;background:#F8F9FA;border-radius:10px;border-right:4px solid #D4AF37;">
                    <p style="margin:0;color:#1A2A3A;font-size:14px;font-weight:bold;">📖 ملخصات احترافية</p>
                    <p style="margin:4px 0 0;color:#687076;font-size:13px;">اقرأ خلاصة أي كتاب في دقائق معدودة</p>
                  </td>
                </tr>
                <tr><td style="height:8px;"></td></tr>
                <tr>
                  <td style="padding:12px;background:#F8F9FA;border-radius:10px;border-right:4px solid #D4AF37;">
                    <p style="margin:0;color:#1A2A3A;font-size:14px;font-weight:bold;">🏆 تحديات 7 أيام</p>
                    <p style="margin:4px 0 0;color:#687076;font-size:13px;">طبّق ما تعلّمته خلال أسبوع واحد فقط</p>
                  </td>
                </tr>
                <tr><td style="height:8px;"></td></tr>
                <tr>
                  <td style="padding:12px;background:#F8F9FA;border-radius:10px;border-right:4px solid #D4AF37;">
                    <p style="margin:0;color:#1A2A3A;font-size:14px;font-weight:bold;">🎧 استمع وشاهد</p>
                    <p style="margin:4px 0 0;color:#687076;font-size:13px;">ملخصات صوتية ومرئية لكل كتاب</p>
                  </td>
                </tr>
                <tr><td style="height:8px;"></td></tr>
                <tr>
                  <td style="padding:12px;background:#F8F9FA;border-radius:10px;border-right:4px solid #D4AF37;">
                    <p style="margin:0;color:#1A2A3A;font-size:14px;font-weight:bold;">💬 مجتمع القرّاء</p>
                    <p style="margin:4px 0 0;color:#687076;font-size:13px;">شارك آراءك وتقييماتك مع القرّاء الآخرين</p>
                  </td>
                </tr>
              </table>
              <div style="text-align:center;margin:0 0 28px;">
                <p style="margin:0 0 16px;color:#687076;font-size:14px;">ابدأ رحلتك الآن واستكشف مكتبتنا من أفضل الكتب</p>
                <a href="https://kitabplus.app" style="display:inline-block;background:#D4AF37;color:#1A2A3A;text-decoration:none;padding:14px 36px;border-radius:50px;font-size:15px;font-weight:bold;">🚀 افتح التطبيق الآن</a>
              </div>
              <div style="background:#1A2A3A;border-radius:12px;padding:20px 24px;text-align:center;margin:0 0 24px;">
                <p style="margin:0;color:#D4AF37;font-size:16px;font-style:italic;line-height:1.6;">"القرّاء يصنعون التاريخ"</p>
              </div>
              <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0;">
              <p style="color:#9BA1A6;margin:0 0 8px;font-size:13px;text-align:center;">
                هل تحتاج مساعدة؟ تواصل معنا على
                <a href="mailto:support@kitabplus.app" style="color:#D4AF37;text-decoration:none;">support@kitabplus.app</a>
              </p>
              <p style="color:#9BA1A6;margin:0;font-size:12px;text-align:center;">هذا البريد أُرسل تلقائياً من ${appName}. يرجى عدم الرد عليه مباشرة.</p>
            </td>
          </tr>
          <tr>
            <td style="background:#F8F9FA;padding:16px 40px;text-align:center;border-top:1px solid #E5E7EB;">
              <p style="margin:0;color:#9BA1A6;font-size:12px;">© 2025 ${appName} · kitabplus.app</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

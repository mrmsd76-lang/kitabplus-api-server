/**
 * email-subscription.ts
 * قالب بريد تأكيد تفعيل الاشتراك
 */

export function buildSubscriptionConfirmEmailHtml(
  userName: string,
  plan: "monthly" | "yearly" | "trial",
  expiry: Date,
  appName = "\u0643\u062a\u0627\u0628 \u0628\u0644\u0633"
): string {
  const planLabel = plan === "monthly" ? "\u0627\u0644\u0634\u0647\u0631\u064a" : plan === "trial" ? "\u0627\u0644\u062a\u062c\u0631\u064a\u0628\u064a (24 \u0633\u0627\u0639\u0629)" : "\u0627\u0644\u0633\u0646\u0648\u064a";
  const planPrice = plan === "monthly" ? "29 \u0631\u064a\u0627\u0644 / \u0634\u0647\u0631" : plan === "trial" ? "\u0645\u062c\u0627\u0646\u064a" : "199 \u0631\u064a\u0627\u0644 / \u0633\u0646\u0629";
  const expiryStr = expiry.toLocaleDateString("ar-SA", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>تاكيد الاشتراك</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif;direction:rtl;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="500" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#1A2A3A;padding:32px 40px;text-align:center;">
              <h1 style="color:#D4AF37;margin:0;font-size:28px;font-weight:bold;">&#128218; ${appName}</h1>
              <p style="color:#9BA1A6;margin:8px 0 0;font-size:14px;">\u0627\u0644\u0645\u0639\u0631\u0641\u0629 \u0641\u064a \u0645\u062a\u0646\u0627\u0648\u0644 \u064a\u062f\u0643</p>
            </td>
          </tr>
          <tr>
            <td style="background:#22C55E;padding:16px 40px;text-align:center;">
              <p style="color:#fff;margin:0;font-size:18px;font-weight:bold;">&#10003; \u062a\u0645 \u062a\u0641\u0639\u064a\u0644 \u0627\u0634\u062a\u0631\u0627\u0643\u0643 \u0628\u0646\u062c\u0627\u062d!</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h2 style="color:#1A2A3A;margin:0 0 16px;font-size:20px;">\u0645\u0631\u062d\u0628\u0627\u064b \u0628\u0643\u060c ${userName}!</h2>
              <p style="color:#687076;margin:0 0 24px;font-size:15px;line-height:1.6;">
                \u064a\u0633\u0639\u062f\u0646\u0627 \u0625\u062e\u0628\u0627\u0631\u0643 \u0628\u0623\u0646 \u0627\u0634\u062a\u0631\u0627\u0643\u0643 \u0641\u064a ${appName} \u0642\u062f \u062a\u0645 \u062a\u0641\u0639\u064a\u0644\u0647 \u0628\u0646\u062c\u0627\u062d. \u0623\u0646\u062a \u0627\u0644\u0622\u0646 \u062a\u0645\u0644\u0643 \u0648\u0635\u0648\u0644\u0627\u064b \u0643\u0627\u0645\u0644\u0627\u064b \u0625\u0644\u0649 \u062c\u0645\u064a\u0639 \u0627\u0644\u0643\u062a\u0628 \u0648\u0627\u0644\u0645\u062d\u062a\u0648\u064a\u0627\u062a.
              </p>
              <div style="background:#F0F9FF;border:1px solid #BAE6FD;border-radius:12px;padding:24px;margin:0 0 24px;">
                <p style="margin:0 0 12px;color:#0369A1;font-size:14px;font-weight:bold;">\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u0627\u0634\u062a\u0631\u0627\u0643</p>
                <table width="100%" cellpadding="6" cellspacing="0">
                  <tr>
                    <td style="color:#687076;font-size:14px;">\u0646\u0648\u0639 \u0627\u0644\u0627\u0634\u062a\u0631\u0627\u0643</td>
                    <td style="color:#1A2A3A;font-size:14px;font-weight:bold;text-align:left;">\u0627\u0634\u062a\u0631\u0627\u0643 ${planLabel}</td>
                  </tr>
                  <tr>
                    <td style="color:#687076;font-size:14px;">\u0627\u0644\u0633\u0639\u0631</td>
                    <td style="color:#1A2A3A;font-size:14px;font-weight:bold;text-align:left;">${planPrice}</td>
                  </tr>
                  <tr>
                    <td style="color:#687076;font-size:14px;">\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0627\u0646\u062a\u0647\u0627\u0621</td>
                    <td style="color:#1A2A3A;font-size:14px;font-weight:bold;text-align:left;">${expiryStr}</td>
                  </tr>
                </table>
              </div>
              <p style="color:#1A2A3A;font-size:15px;font-weight:bold;margin:0 0 12px;">\u0645\u0627 \u064a\u0645\u0643\u0646\u0643 \u0627\u0644\u0622\u0646:</p>
              <ul style="color:#687076;font-size:14px;line-height:2;margin:0 0 24px;padding-right:20px;">
                <li>&#128218; \u0627\u0644\u0648\u0635\u0648\u0644 \u0625\u0644\u0649 \u0645\u0643\u062a\u0628\u0629 \u062a\u0636\u0645 \u0623\u0643\u062b\u0631 \u0645\u0646 40 \u0643\u062a\u0627\u0628\u0627\u064b</li>
                <li>&#129504; \u062a\u062d\u062f\u064a\u0627\u062a \u0627\u0644\u0642\u0631\u0627\u0621\u0629 \u0648\u0627\u0644\u0627\u062e\u062a\u0628\u0627\u0631\u0627\u062a \u0627\u0644\u062a\u0641\u0627\u0639\u0644\u064a\u0629</li>
                <li>&#127919; \u062a\u062a\u0628\u0639 \u062a\u0642\u062f\u0645\u0643 \u0648\u0625\u062d\u0635\u0627\u0626\u064a\u0627\u062a\u0643 \u0627\u0644\u0634\u062e\u0635\u064a\u0629</li>
                <li>&#11088; \u0645\u062d\u062a\u0648\u0649 \u062d\u0635\u0631\u064a \u064a\u064f\u0636\u0627\u0641 \u0628\u0627\u0633\u062a\u0645\u0631\u0627\u0631</li>
              </ul>
              <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0;">
              <p style="color:#9BA1A6;margin:0;font-size:12px;text-align:center;">
                \u0647\u0630\u0627 \u0627\u0644\u0628\u0631\u064a\u062f \u0623\u064f\u0631\u0633\u0644 \u062a\u0644\u0642\u0627\u0626\u064a\u0627\u064b \u0645\u0646 ${appName}. \u064a\u0631\u062c\u0649 \u0639\u062f\u0645 \u0627\u0644\u0631\u062f \u0639\u0644\u064a\u0647.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * قالب بريد تذكير تجديد الاشتراك قبل انتهائه
 */
export function buildRenewalReminderEmailHtml(
  userName: string,
  daysLeft: number,
  expiry: Date,
  appName = "كتاب+"
): string {
  const expiryStr = expiry.toLocaleDateString("ar-SA", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const urgencyColor = daysLeft <= 3 ? "#EF4444" : daysLeft <= 7 ? "#F59E0B" : "#0a7ea4";
  const urgencyLabel = daysLeft <= 3 ? "عاجل" : daysLeft <= 7 ? "تنبيه" : "تذكير";

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>تذكير تجديد الاشتراك</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif;direction:rtl;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="500" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#1A2A3A;padding:32px 40px;text-align:center;">
              <h1 style="color:#D4AF37;margin:0;font-size:28px;font-weight:bold;">&#128218; ${appName}</h1>
              <p style="color:#9BA1A6;margin:8px 0 0;font-size:14px;">المعرفة في متناول يدك</p>
            </td>
          </tr>
          <tr>
            <td style="background:${urgencyColor};padding:16px 40px;text-align:center;">
              <p style="color:#fff;margin:0;font-size:18px;font-weight:bold;">&#9200; ${urgencyLabel}: اشتراكك ينتهي خلال ${daysLeft} يوم</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h2 style="color:#1A2A3A;margin:0 0 16px;font-size:20px;">مرحباً بك، ${userName}!</h2>
              <p style="color:#687076;margin:0 0 24px;font-size:15px;line-height:1.6;">
                نود تذكيرك بأن اشتراكك في ${appName} سينتهي في <strong style="color:#1A2A3A;">${expiryStr}</strong>.
                لا تفوّت فرصة الاستمرار في رحلتك المعرفية!
              </p>
              <div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:12px;padding:24px;margin:0 0 24px;">
                <p style="margin:0 0 8px;color:#C2410C;font-size:14px;font-weight:bold;">&#9888; تاريخ انتهاء اشتراكك</p>
                <p style="margin:0;color:#1A2A3A;font-size:22px;font-weight:bold;">${expiryStr}</p>
                <p style="margin:8px 0 0;color:#9A3412;font-size:13px;">تبقّى ${daysLeft} يوم فقط — جدّد الآن لتحافظ على وصولك الكامل</p>
              </div>
              <p style="color:#1A2A3A;font-size:15px;font-weight:bold;margin:0 0 12px;">ما ستفقده بعد انتهاء الاشتراك:</p>
              <ul style="color:#687076;font-size:14px;line-height:2;margin:0 0 24px;padding-right:20px;">
                <li>&#128218; الوصول إلى أكثر من 40 كتاباً مميزاً</li>
                <li>&#129504; التحديات والاختبارات التفاعلية</li>
                <li>&#127919; تتبع تقدمك وإحصائياتك الشخصية</li>
                <li>&#11088; المحتوى الحصري الجديد</li>
              </ul>
              <div style="text-align:center;margin:0 0 24px;">
                <a href="https://knowledgestore-hmlmznpf.manus.space" style="display:inline-block;background:#D4AF37;color:#1A2A3A;font-size:16px;font-weight:bold;padding:14px 40px;border-radius:50px;text-decoration:none;">
                  &#128218; جدّد اشتراكك الآن
                </a>
              </div>
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
</html>`;
}


/**
 * قالب HTML لبريد إيصال الدفع الناجح
 * يُرسل فور نجاح عملية الدفع ويتضمن تفاصيل المعاملة
 */
export function buildPaymentReceiptEmailHtml(params: {
  userName: string;
  plan: "monthly" | "yearly";
  amount: number;
  currency: string;
  chargeId: string | null;
  referenceId: string;
  cardBrand?: string | null;
  cardLast4?: string | null;
  expiry: Date;
  appName?: string;
}): string {
  const {
    userName,
    plan,
    amount,
    currency,
    chargeId,
    referenceId,
    cardBrand,
    cardLast4,
    expiry,
    appName = "كتاب+",
  } = params;

  const planLabel = plan === "monthly" ? "الشهري" : "السنوي";
  const expiryStr = expiry.toLocaleDateString("ar-SA", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const nowStr = new Date().toLocaleDateString("ar-SA", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const cardInfo = cardBrand && cardLast4
    ? `${cardBrand} •••• ${cardLast4}`
    : cardLast4
    ? `•••• ${cardLast4}`
    : "بطاقة بنكية";

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>إيصال الدفع — ${appName}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif;direction:rtl;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:#1A2A3A;padding:32px 40px;text-align:center;">
              <h1 style="color:#D4AF37;margin:0;font-size:28px;font-weight:bold;">📚 ${appName}</h1>
              <p style="color:#9BA1A6;margin:8px 0 0;font-size:14px;">المعرفة في متناول يدك</p>
            </td>
          </tr>

          <!-- Success Banner -->
          <tr>
            <td style="background:#22C55E;padding:20px 40px;text-align:center;">
              <p style="color:#fff;margin:0;font-size:20px;font-weight:bold;">✅ تم الدفع بنجاح!</p>
              <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px;">تم تفعيل اشتراكك ${planLabel} في ${appName}</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <h2 style="color:#1A2A3A;margin:0 0 8px;font-size:20px;">مرحباً ${userName}،</h2>
              <p style="color:#687076;margin:0 0 28px;font-size:15px;line-height:1.7;">
                شكراً لاشتراكك في <strong>${appName}</strong>. تم استلام دفعتك بنجاح وتفعيل اشتراكك فوراً.
                يمكنك الآن الوصول إلى جميع الكتب والمحتوى المميز.
              </p>

              <!-- Receipt Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;margin:0 0 28px;">
                <tr>
                  <td style="background:#1A2A3A;padding:14px 20px;">
                    <p style="color:#D4AF37;margin:0;font-size:14px;font-weight:bold;">🧾 إيصال الدفع</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding:8px 0;border-bottom:1px solid #E5E7EB;">
                          <table width="100%"><tr>
                            <td style="color:#1A2A3A;font-size:14px;font-weight:600;">المبلغ المدفوع</td>
                            <td align="left" style="color:#22C55E;font-size:18px;font-weight:800;">${amount} ${currency}</td>
                          </tr></table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;border-bottom:1px solid #E5E7EB;">
                          <table width="100%"><tr>
                            <td style="color:#687076;font-size:13px;">نوع الاشتراك</td>
                            <td align="left" style="color:#1A2A3A;font-size:13px;font-weight:600;">اشتراك ${planLabel}</td>
                          </tr></table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;border-bottom:1px solid #E5E7EB;">
                          <table width="100%"><tr>
                            <td style="color:#687076;font-size:13px;">تاريخ الدفع</td>
                            <td align="left" style="color:#1A2A3A;font-size:13px;">${nowStr}</td>
                          </tr></table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;border-bottom:1px solid #E5E7EB;">
                          <table width="100%"><tr>
                            <td style="color:#687076;font-size:13px;">وسيلة الدفع</td>
                            <td align="left" style="color:#1A2A3A;font-size:13px;">💳 ${cardInfo}</td>
                          </tr></table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;border-bottom:1px solid #E5E7EB;">
                          <table width="100%"><tr>
                            <td style="color:#687076;font-size:13px;">صالح حتى</td>
                            <td align="left" style="color:#1A2A3A;font-size:13px;font-weight:600;">${expiryStr}</td>
                          </tr></table>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0;border-bottom:1px solid #E5E7EB;">
                          <table width="100%"><tr>
                            <td style="color:#687076;font-size:13px;">رقم المرجع</td>
                            <td align="left" style="color:#687076;font-size:12px;font-family:monospace;">${referenceId}</td>
                          </tr></table>
                        </td>
                      </tr>
                      ${chargeId ? `<tr>
                        <td style="padding:8px 0;">
                          <table width="100%"><tr>
                            <td style="color:#687076;font-size:13px;">رقم العملية</td>
                            <td align="left" style="color:#687076;font-size:12px;font-family:monospace;">${chargeId}</td>
                          </tr></table>
                        </td>
                      </tr>` : ""}
                    </table>
                  </td>
                </tr>
              </table>

              <!-- What's Unlocked -->
              <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:12px;padding:20px;margin:0 0 28px;">
                <p style="color:#15803D;margin:0 0 12px;font-size:14px;font-weight:bold;">🎉 ما يمكنك الوصول إليه الآن:</p>
                <ul style="color:#166534;font-size:13px;line-height:2;margin:0;padding-right:20px;">
                  <li>📚 جميع الكتب والملخصات المميزة</li>
                  <li>🎯 التحديات الأسبوعية وبطاقات التقييم</li>
                  <li>🎵 الكتب المسموعة وملخصات الفيديو</li>
                  <li>💬 المناقشات والتعليقات التفاعلية</li>
                  <li>⭐ المحتوى الحصري الجديد أولاً بأول</li>
                </ul>
              </div>

              <!-- CTA Button -->
              <div style="text-align:center;margin:0 0 28px;">
                <a href="https://knowledgestore-hmlmznpf.manus.space" style="display:inline-block;background:#D4AF37;color:#1A2A3A;font-size:16px;font-weight:bold;padding:14px 48px;border-radius:50px;text-decoration:none;">
                  📖 ابدأ القراءة الآن
                </a>
              </div>

              <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0;">
              <p style="color:#9BA1A6;margin:0;font-size:12px;text-align:center;line-height:1.6;">
                هذا البريد أُرسل تلقائياً من ${appName} كتأكيد لعملية الدفع.<br>
                احتفظ بهذا الإيصال لسجلاتك. يرجى عدم الرد على هذا البريد.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * payment.ts — خدمة الدفع الرباعية
 * تدعم: Tap Payments (الخليج) + Paddle (دولي) + PayPal (دولي) + STC Pay (السعودية)
 *
 * Tap Payments Docs: https://developers.tap.company/docs
 * Paddle Docs:       https://developer.paddle.com/api-reference
 * PayPal Docs:       https://developer.paypal.com/docs/api/orders/v2
 * STC Pay Docs:      https://b2b.stcpay.com.sa (يتطلب اتفاقية تجارية)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type PaymentGateway = 'tap' | 'paddle' | 'paypal' | 'stcpay';

export interface CreateChargeInput {
  gateway: PaymentGateway;
  amount: number;          // بالريال السعودي أو الدولار
  currency: string;        // 'SAR' | 'USD' | 'AED' | 'KWD'
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  description: string;
  orderId: string;         // معرّف الطلب الداخلي
  redirectUrl: string;     // URL للعودة بعد الدفع
  // Tap-specific
  cardToken?: string;
  // Paddle-specific
  priceId?: string;
}

export interface ChargeResult {
  success: boolean;
  chargeId?: string;
  paymentUrl?: string;
  status?: string;
  error?: string;
  gateway: PaymentGateway;
  cardBrand?: string | null;
  cardLast4?: string | null;
}

export interface VerifyPaymentInput {
  gateway: PaymentGateway;
  chargeId: string;
}

export interface VerifyResult {
  success: boolean;
  paid: boolean;
  amount?: number;
  currency?: string;
  customerEmail?: string;
  error?: string;
}

// ── Tap Payments ──────────────────────────────────────────────────────────────

const TAP_API_BASE = 'https://api.tap.company/v2';

async function tapCreateCharge(input: CreateChargeInput): Promise<ChargeResult> {
  const secretKey = process.env.TAP_SECRET_KEY;
  if (!secretKey) {
    return { success: false, error: 'TAP_SECRET_KEY غير مُعيَّن', gateway: 'tap' };
  }

  const body = {
    amount: input.amount,
    currency: input.currency || 'SAR',
    customer_initiated: true,
    threeDSecure: true,
    save_card: false,
    description: input.description,
    metadata: { orderId: input.orderId },
    reference: { transaction: input.orderId, order: input.orderId },
    receipt: { email: true, sms: false },
    customer: {
      first_name: input.customerName.split(' ')[0] || input.customerName,
      last_name: input.customerName.split(' ').slice(1).join(' ') || '',
      email: input.customerEmail,
      phone: input.customerPhone
        ? { country_code: '966', number: input.customerPhone }
        : undefined,
    },
    source: input.cardToken ? { id: input.cardToken } : { id: 'src_all' },
    redirect: { url: input.redirectUrl },
  };

  try {
    const res = await fetch(`${TAP_API_BASE}/charges`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      const errMsg = (data?.errors as Array<{description?: string}>)?.[0]?.description
        ?? (data?.message as string)
        ?? 'خطأ من Tap Payments';
      return { success: false, error: errMsg, gateway: 'tap' };
    }

    const transaction = data?.transaction as Record<string, unknown> | undefined;
    const paymentUrl = (transaction?.url as string) ?? undefined;
    // استخراج بيانات البطاقة من استجابة Tap
    const card = data?.card as Record<string, unknown> | undefined;
    const cardBrand = (card?.brand as string) ?? null;
    const cardLast4 = (card?.last_four as string) ?? null;
    return {
      success: true,
      chargeId: data?.id as string,
      paymentUrl,
      status: data?.status as string,
      gateway: 'tap',
      cardBrand,
      cardLast4,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'خطأ في الاتصال بـ Tap Payments',
      gateway: 'tap',
    };
  }
}

async function tapVerifyCharge(chargeId: string): Promise<VerifyResult> {
  const secretKey = process.env.TAP_SECRET_KEY;
  if (!secretKey) return { success: false, paid: false, error: 'TAP_SECRET_KEY غير مُعيَّن' };

  try {
    const res = await fetch(`${TAP_API_BASE}/charges/${chargeId}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) return { success: false, paid: false, error: 'تعذّر التحقق من الدفع' };

    const paid = data?.status === 'CAPTURED';
    const customer = data?.customer as Record<string, unknown> | undefined;

    return {
      success: true,
      paid,
      amount: data?.amount as number | undefined,
      currency: data?.currency as string | undefined,
      customerEmail: customer?.email as string | undefined,
    };
  } catch (err) {
    return { success: false, paid: false, error: err instanceof Error ? err.message : 'خطأ في الاتصال' };
  }
}

// ── Paddle ────────────────────────────────────────────────────────────────────

const PADDLE_API_BASE = 'https://sandbox-api.paddle.com';
// للإنتاج: 'https://api.paddle.com'

async function paddleCreateTransaction(input: CreateChargeInput): Promise<ChargeResult> {
  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) return { success: false, error: 'PADDLE_API_KEY غير مُعيَّن', gateway: 'paddle' };

  const priceId = input.priceId
    ?? (input.description.includes('سنوي') || input.description.includes('yearly')
      ? process.env.PADDLE_YEARLY_PRICE_ID
      : process.env.PADDLE_MONTHLY_PRICE_ID);

  if (!priceId) return { success: false, error: 'لم يتم تحديد Price ID لـ Paddle', gateway: 'paddle' };

  const body = {
    items: [{ price_id: priceId, quantity: 1 }],
    customer: { email: input.customerEmail },
    custom_data: { orderId: input.orderId },
    success_url: input.redirectUrl,
  };

  try {
    const res = await fetch(`${PADDLE_API_BASE}/transactions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      const errData = data?.error as Record<string, unknown> | undefined;
      return { success: false, error: (errData?.detail as string) ?? 'خطأ من Paddle', gateway: 'paddle' };
    }

    const txData = data?.data as Record<string, unknown> | undefined;
    const checkout = txData?.checkout as Record<string, unknown> | undefined;

    return {
      success: true,
      chargeId: txData?.id as string,
      paymentUrl: (checkout?.url as string) ?? undefined,
      status: txData?.status as string,
      gateway: 'paddle',
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'خطأ في الاتصال بـ Paddle', gateway: 'paddle' };
  }
}

async function paddleVerifyTransaction(transactionId: string): Promise<VerifyResult> {
  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) return { success: false, paid: false, error: 'PADDLE_API_KEY غير مُعيَّن' };

  try {
    const res = await fetch(`${PADDLE_API_BASE}/transactions/${transactionId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) return { success: false, paid: false, error: 'تعذّر التحقق من الدفع' };

    const txData = data?.data as Record<string, unknown> | undefined;
    const paid = txData?.status === 'completed' || txData?.status === 'billed';
    const customer = txData?.customer as Record<string, unknown> | undefined;
    const details = txData?.details as Record<string, unknown> | undefined;
    const totals = details?.totals as Record<string, unknown> | undefined;

    return {
      success: true,
      paid,
      amount: totals?.total as number | undefined,
      currency: txData?.currency_code as string | undefined,
      customerEmail: customer?.email as string | undefined,
    };
  } catch (err) {
    return { success: false, paid: false, error: err instanceof Error ? err.message : 'خطأ في الاتصال' };
  }
}

// ── PayPal ────────────────────────────────────────────────────────────────────
// PayPal REST API v2 — Orders
// Docs: https://developer.paypal.com/docs/api/orders/v2

async function paypalGetAccessToken(): Promise<string | null> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const mode = process.env.PAYPAL_MODE ?? 'sandbox';
  const base = mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    return data?.access_token as string ?? null;
  } catch {
    return null;
  }
}

async function paypalCreateOrder(input: CreateChargeInput): Promise<ChargeResult> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  if (!clientId || clientId === 'PAYPAL_SANDBOX_CLIENT_ID_PLACEHOLDER') {
    return {
      success: false,
      error: 'PayPal غير مُفعَّل بعد — يرجى إضافة PAYPAL_CLIENT_ID الحقيقي من developer.paypal.com',
      gateway: 'paypal',
    };
  }

  const accessToken = await paypalGetAccessToken();
  if (!accessToken) {
    return { success: false, error: 'فشل الحصول على رمز PayPal — تحقق من Client ID و Secret', gateway: 'paypal' };
  }

  const mode = process.env.PAYPAL_MODE ?? 'sandbox';
  const base = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

  // تحويل المبلغ إلى USD إذا كانت العملة SAR (1 USD ≈ 3.75 SAR)
  const currency = input.currency === 'SAR' ? 'USD' : input.currency;
  const amount = input.currency === 'SAR'
    ? (input.amount / 3.75).toFixed(2)
    : input.amount.toFixed(2);

  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: input.orderId,
      description: input.description,
      amount: {
        currency_code: currency,
        value: amount,
      },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
          brand_name: 'كتاب+',
          locale: 'ar-SA',
          landing_page: 'LOGIN',
          user_action: 'PAY_NOW',
          return_url: input.redirectUrl,
          cancel_url: input.redirectUrl + '?status=cancelled',
        },
      },
    },
  };

  try {
    const res = await fetch(`${base}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': input.orderId,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      const errMsg = (data?.message as string) ?? 'خطأ من PayPal';
      return { success: false, error: errMsg, gateway: 'paypal' };
    }

    // استخراج رابط الموافقة
    const links = data?.links as Array<{ rel: string; href: string }> | undefined;
    const approveLink = links?.find(l => l.rel === 'payer-action' || l.rel === 'approve');

    return {
      success: true,
      chargeId: data?.id as string,
      paymentUrl: approveLink?.href,
      status: data?.status as string,
      gateway: 'paypal',
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'خطأ في الاتصال بـ PayPal',
      gateway: 'paypal',
    };
  }
}

async function paypalCaptureOrder(orderId: string): Promise<VerifyResult> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  if (!clientId || clientId === 'PAYPAL_SANDBOX_CLIENT_ID_PLACEHOLDER') {
    return { success: false, paid: false, error: 'PayPal غير مُفعَّل' };
  }

  const accessToken = await paypalGetAccessToken();
  if (!accessToken) return { success: false, paid: false, error: 'فشل الحصول على رمز PayPal' };

  const mode = process.env.PAYPAL_MODE ?? 'sandbox';
  const base = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

  try {
    // أولاً: التحقق من حالة الطلب
    const getRes = await fetch(`${base}/v2/checkout/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const orderData = await getRes.json() as Record<string, unknown>;
    const orderStatus = orderData?.status as string | undefined;

    // إذا كان مكتملاً بالفعل
    if (orderStatus === 'COMPLETED') {
      const units = orderData?.purchase_units as Array<Record<string, unknown>> | undefined;
      const capture = (units?.[0]?.payments as Record<string, unknown>)?.captures as Array<Record<string, unknown>> | undefined;
      const captureData = capture?.[0];
      const amountData = captureData?.amount as Record<string, unknown> | undefined;
      return {
        success: true,
        paid: true,
        amount: parseFloat(amountData?.value as string ?? '0'),
        currency: amountData?.currency_code as string | undefined,
      };
    }

    // إذا كانت في انتظار الموافقة، نحاول الـ capture
    if (orderStatus === 'APPROVED') {
      const captureRes = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      const captureData = await captureRes.json() as Record<string, unknown>;
      const captured = captureData?.status === 'COMPLETED';
      const units = captureData?.purchase_units as Array<Record<string, unknown>> | undefined;
      const captures = (units?.[0]?.payments as Record<string, unknown>)?.captures as Array<Record<string, unknown>> | undefined;
      const firstCapture = captures?.[0];
      const amountData = firstCapture?.amount as Record<string, unknown> | undefined;
      const payerData = captureData?.payer as Record<string, unknown> | undefined;

      return {
        success: true,
        paid: captured,
        amount: parseFloat(amountData?.value as string ?? '0'),
        currency: amountData?.currency_code as string | undefined,
        customerEmail: payerData?.email_address as string | undefined,
      };
    }

    return { success: true, paid: false, error: `حالة PayPal: ${orderStatus}` };
  } catch (err) {
    return { success: false, paid: false, error: err instanceof Error ? err.message : 'خطأ في الاتصال' };
  }
}

// ── STC Pay ───────────────────────────────────────────────────────────────────
// STC Pay B2B API — يتطلب اتفاقية تجارية مع STC
// Docs: https://b2b.stcpay.com.sa
// ملاحظة: الكود جاهز للتفعيل عند الحصول على المفاتيح الحقيقية

const STC_PAY_API_BASE = 'https://b2b.stcpay.com.sa/api/v1';
// للاختبار: 'https://b2b-sandbox.stcpay.com.sa/api/v1'

async function stcPayCreatePayment(input: CreateChargeInput): Promise<ChargeResult> {
  const apiKey = process.env.STC_PAY_API_KEY;
  const merchantId = process.env.STC_PAY_MERCHANT_ID;

  if (!apiKey || apiKey === 'STC_PAY_API_KEY_PLACEHOLDER') {
    return {
      success: false,
      error: 'STC Pay غير مُفعَّل بعد — يتطلب اتفاقية تجارية مع STC. تواصل مع stcpay.com.sa/business',
      gateway: 'stcpay',
    };
  }

  if (!merchantId || merchantId === 'STC_PAY_MERCHANT_ID_PLACEHOLDER') {
    return { success: false, error: 'STC_PAY_MERCHANT_ID غير مُعيَّن', gateway: 'stcpay' };
  }

  const body = {
    MerchantId: merchantId,
    BranchId: '1',
    TellerNo: '1',
    DeviceId: '1',
    RefNum: input.orderId,
    BillNumber: input.orderId,
    MobileNo: input.customerPhone ?? '',
    Amount: input.amount,
    Currency: 'SAR',
    Description: input.description,
    NotificationUrl: `${process.env.APP_BASE_URL ?? 'https://knowledgestore-hmlmznpf.manus.space'}/api/webhooks/stcpay`,
  };

  try {
    const res = await fetch(`${STC_PAY_API_BASE}/payment/initiate`, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) {
      return {
        success: false,
        error: (data?.Message as string) ?? (data?.message as string) ?? 'خطأ من STC Pay',
        gateway: 'stcpay',
      };
    }

    // STC Pay يُرسل OTP للعميل ويعيد رابط الدفع أو QR code
    const paymentUrl = (data?.PaymentURL as string)
      ?? (data?.paymentUrl as string)
      ?? (data?.CheckoutURL as string)
      ?? undefined;

    return {
      success: true,
      chargeId: (data?.STCPayPmtReference as string) ?? (data?.RefNum as string) ?? input.orderId,
      paymentUrl,
      status: 'INITIATED',
      gateway: 'stcpay',
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'خطأ في الاتصال بـ STC Pay',
      gateway: 'stcpay',
    };
  }
}

async function stcPayVerifyPayment(refNum: string): Promise<VerifyResult> {
  const apiKey = process.env.STC_PAY_API_KEY;
  const merchantId = process.env.STC_PAY_MERCHANT_ID;

  if (!apiKey || apiKey === 'STC_PAY_API_KEY_PLACEHOLDER') {
    return { success: false, paid: false, error: 'STC Pay غير مُفعَّل' };
  }

  try {
    const res = await fetch(`${STC_PAY_API_BASE}/payment/inquiry`, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ MerchantId: merchantId, RefNum: refNum }),
    });

    const data = await res.json() as Record<string, unknown>;

    if (!res.ok) return { success: false, paid: false, error: 'تعذّر التحقق من دفع STC Pay' };

    // حالة الدفع الناجح في STC Pay: StatusCode === 1 أو Status === 'Paid'
    const statusCode = data?.StatusCode as number | undefined;
    const status = data?.Status as string | undefined;
    const paid = statusCode === 1 || status === 'Paid' || status === 'SUCCESS';

    return {
      success: true,
      paid,
      amount: data?.Amount as number | undefined,
      currency: 'SAR',
    };
  } catch (err) {
    return { success: false, paid: false, error: err instanceof Error ? err.message : 'خطأ في الاتصال' };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * إنشاء عملية دفع عبر البوابة المحددة
 */
export async function createCharge(input: CreateChargeInput): Promise<ChargeResult> {
  switch (input.gateway) {
    case 'tap':     return tapCreateCharge(input);
    case 'paddle':  return paddleCreateTransaction(input);
    case 'paypal':  return paypalCreateOrder(input);
    case 'stcpay':  return stcPayCreatePayment(input);
    default:        return { success: false, error: 'بوابة دفع غير معروفة', gateway: input.gateway };
  }
}

/**
 * التحقق من حالة عملية الدفع
 */
export async function verifyPayment(input: VerifyPaymentInput): Promise<VerifyResult> {
  switch (input.gateway) {
    case 'tap':     return tapVerifyCharge(input.chargeId);
    case 'paddle':  return paddleVerifyTransaction(input.chargeId);
    case 'paypal':  return paypalCaptureOrder(input.chargeId);
    case 'stcpay':  return stcPayVerifyPayment(input.chargeId);
    default:        return { success: false, paid: false, error: 'بوابة دفع غير معروفة' };
  }
}

/**
 * حساب تاريخ انتهاء الاشتراك بناءً على الخطة
 */
export function calcSubscriptionExpiry(plan: 'monthly' | 'yearly' | 'trial'): Date {
  const now = new Date();
  if (plan === 'yearly') {
    now.setFullYear(now.getFullYear() + 1);
  } else if (plan === 'trial') {
    now.setHours(now.getHours() + 24);
  } else {
    now.setMonth(now.getMonth() + 1);
  }
  return now;
}

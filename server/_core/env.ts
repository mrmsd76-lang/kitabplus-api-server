export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  // Email service (Resend) — set RESEND_API_KEY in environment secrets
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  // Sender email address — use a verified domain in production
  // In test mode: only sends to the Resend account owner email
  emailFrom: process.env.EMAIL_FROM ?? "onboarding@resend.dev",
};

import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerWebhookRoutes } from "../webhook";
import { startRenewalReminderScheduler } from "../renewal-reminder";
import { startPushNotificationScheduler } from "../push-notifications";
import { appRouter } from "../routers";
import { createContext } from "./context";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Enable CORS for all routes - reflect the request origin to support credentials
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.header("Access-Control-Allow-Origin", origin);
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization",
    );
    res.header("Access-Control-Allow-Credentials", "true");

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Webhooks MUST be registered before express.json() to capture raw body for signature verification
  registerWebhookRoutes(app);

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  registerOAuthRoutes(app);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
  });

  // Debug endpoint to test Supabase REST API connectivity
  app.get("/api/debug/db-test", async (_req, res) => {
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const supabaseUrlMasked = supabaseUrl || 'NOT SET';
    const serviceKeyMasked = serviceKey ? serviceKey.substring(0, 20) + '...' : 'NOT SET';
    
    try {
      // Test Supabase REST API by reading from users table
      const { sbGetSessionUserByOpenId, sbUpsertSessionUser } = await import('../supabase-session-users.js');
      
      // Test upsert with a debug user
      await sbUpsertSessionUser({
        openId: 'debug_test_user',
        name: 'Debug Test',
        email: 'debug@test.com',
        loginMethod: 'debug',
        role: 'user',
      });
      
      // Test read
      const user = await sbGetSessionUserByOpenId('debug_test_user');
      
      return res.json({
        ok: true,
        supabaseUrlMasked,
        serviceKeyMasked,
        upsertOk: true,
        readOk: !!user,
        user: user ? { id: user.id, openId: user.openId, name: user.name } : null,
      });
    } catch (error: any) {
      return res.json({
        ok: false,
        supabaseUrlMasked,
        serviceKeyMasked,
        error: error?.message,
        fullError: String(error).substring(0, 2000),
      });
    }
  });

  // Debug endpoint to test sbGetAllAppUsers with service role key
  app.get("/api/debug/users-test", async (_req, res) => {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const serviceKeyMasked = serviceKey ? serviceKey.substring(0, 20) + '...' : 'NOT SET';
    try {
      const { sbGetAllAppUsers } = await import('../supabase-users.js');
      const users = await sbGetAllAppUsers();
      return res.json({
        ok: true,
        serviceKeyMasked,
        userCount: users.length,
        firstUser: users[0] ? { id: users[0].id, name: users[0].name, email: users[0].email } : null,
      });
    } catch (error: any) {
      return res.json({
        ok: false,
        serviceKeyMasked,
        error: error?.message,
      });
    }
  });

  // Debug endpoint to test Supabase REST connectivity
  app.get("/api/debug/rest-test", async (_req, res) => {
    try {
      const { getAllDiscountCodes, getInstallStats } = await import('../db.js');
      const discounts = await getAllDiscountCodes();
      const installs = await getInstallStats();
      return res.json({
        ok: true,
        discountCount: discounts.length,
        installCount: installs.total,
        message: 'Supabase REST API is working correctly'
      });
    } catch (error: any) {
      return res.json({ ok: false, error: error?.message });
    }
  });


  // رابط تنزيل APK المخصص — يعيد التوجيه لأحدث إصدار على GitHub
  app.get("/download", (_req, res) => {
    res.redirect(301, "https://github.com/mrmsd76-lang/kitabplus-releases/releases/latest/download/bookstore-app.apk");
  });

  // رابط بديل مختصر
  app.get("/apk", (_req, res) => {
    res.redirect(301, "https://github.com/mrmsd76-lang/kitabplus-releases/releases/latest/download/bookstore-app.apk");
  });

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      onError({ error, type, path, input }) {
        console.error(`[tRPC Error] ${type} ${path}:`, error.message);
        if (error.cause) {
          console.error('[tRPC Error] cause:', JSON.stringify(error.cause, null, 2));
        }
        // Log the full error object for PostgreSQL errors
        const cause = error.cause as any;
        if (cause?.code || cause?.constraint || cause?.detail) {
          console.error('[DB Error] code:', cause.code, 'constraint:', cause.constraint, 'detail:', cause.detail, 'message:', cause.message);
        }
      },
    }),
  );

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`[api] server listening on port ${port}`);
    // تشغيل خدمة تذكير تجديد الاشتراك التلقائي (بريد + push)
    startRenewalReminderScheduler();
    startPushNotificationScheduler();
  });
}

startServer().catch(console.error);



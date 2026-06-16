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

  // Debug endpoint to test DB connection and upsert
  app.get("/api/debug/db-test", async (_req, res) => {
    try {
      const { getDb } = await import('../db.js');
      const db = await getDb();
      if (!db) {
        return res.json({ ok: false, error: 'Database not available - DATABASE_URL may be missing' });
      }
      // Try a simple select
      const { sql } = await import('drizzle-orm');
      const result = await db.execute(sql`SELECT current_database(), current_user, version()`);
      res.json({ ok: true, dbInfo: result.rows ?? result });
    } catch (error: any) {
      res.json({
        ok: false,
        error: error?.message,
        code: error?.code,
        detail: error?.detail,
        hint: error?.hint,
        fullError: String(error),
      });
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

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { registerAuthPlugin } from './middleware/auth.js';
import { registerIngestRoutes } from './modules/ingest/routes.js';
import { registerSystemRoutes } from './modules/systems/routes.js';
import { registerSourceRoutes } from './modules/sources/routes.js';
import { registerScoresRoutes } from './modules/scores/routes.js';
import { registerDashboardRoutes } from './modules/dashboard/routes.js';
import { registerAlertingRoutes } from './modules/alerting/routes.js';
import { registerConnectorRoutes } from './modules/connectors/routes.js';
import { registerFeaturesRoutes } from './modules/features/routes.js';
import { registerEventRoutes } from './modules/events/routes.js';
import { localTimestamp } from './config/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  const isProd = process.env.NODE_ENV === 'production';
  const app = Fastify({
    logger: isProd
      ? true // structured JSON logging in production (efficient, ELK/Datadog friendly)
      : {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' },
          },
        },
    // A03: reject payloads over 1 MB to prevent abuse
    bodyLimit: 1_048_576,
  });

  // ── Security plugins (A05: secure headers, CORS) ──────────
  await app.register(helmet, {
    contentSecurityPolicy: false, // dashboard will set its own CSP
  });

  const corsOrigin = process.env.CORS_ORIGIN;
  await app.register(cors, {
    origin: corsOrigin ? corsOrigin.split(',').map((s) => s.trim()) : true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  // ── Auth plugin (decorates request.apiKey) ─────────────────
  // Must be registered before routes so request.apiKey is decorated
  registerAuthPlugin(app);

  // ── Rate limiting (A01) ────────────────────────────────────
  // Note: keyGenerator uses request.ip since apiKey is only set
  // in per-route preHandlers, which run after the rate-limit hook.
  await app.register(rateLimit, {
    max: 200,          // requests per window
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });

  // ── Health check ───────────────────────────────────────────
  app.get('/healthz', async () => ({ status: 'ok', time: localTimestamp() }));

  // ── API routes ─────────────────────────────────────────────
  await registerIngestRoutes(app);
  await registerSystemRoutes(app);
  await registerSourceRoutes(app);
  await registerScoresRoutes(app);
  await registerDashboardRoutes(app);
  await registerAlertingRoutes(app);
  await registerConnectorRoutes(app);
  await registerFeaturesRoutes(app);
  await registerEventRoutes(app);

  return app;
}

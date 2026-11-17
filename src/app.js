import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import authRoutes from './routes/auth.js';
import meetingRoutes from './routes/meetings.js';
import contentRoutes from './routes/content.js';
import summaryRoutes from './routes/summary.js';
import actionItemRoutes from './routes/actionItems.js';
import metaRoutes from './routes/meta.js';
import diagnosticsRoutes from './routes/diagnostics.js';
import { apiLimiter } from './middleware/rateLimits.js';
import { notFoundHandler, errorHandler } from './middleware/errors.js';
import { openApiSpec } from './docs/openapi.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({
    // Only the configured frontend origin(s) may call the API from a browser; no-Origin requests (curl/Postman) are allowed.
    origin: (origin, cb) => cb(null, !origin || env.frontendOrigins.includes(origin)),
    credentials: true
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', apiLimiter);

  // API documentation (Swagger UI is loaded from a CDN, so this route gets a relaxed CSP of its own).
  app.get('/api/docs.json', (_req, res) => res.json(openApiSpec));
  app.get('/api/docs', (_req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https:; connect-src 'self'");
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Lingua Meet API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head><body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.ui=SwaggerUIBundle({url:'/api/docs.json',dom_id:'#ui'});</script></body></html>`);
  });

  app.use('/api', metaRoutes);
  app.use('/api/diagnostics', diagnosticsRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/meetings', meetingRoutes);
  app.use('/api/meetings', contentRoutes);   // /:id/transcripts, /:id/audio, /:id/translations
  app.use('/api/meetings', summaryRoutes);   // /:id/summarize, /:id/summary
  app.use('/api', actionItemRoutes);         // /meetings/:id/action-items, /action-items/:id

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

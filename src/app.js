import express from 'express';
import { resolve } from 'node:path';
import { createAuth } from './auth.js';
import { createRoutes } from './routes.js';

export function createApp({ store, whatsapp, scheduler, appPassword = process.env.APP_PASSWORD,
  secureCookie = process.env.COOKIE_SECURE === 'true', publicDir = resolve('public') }) {
  const auth = createAuth({ password: appPassword, secureCookie });
  const app = express();

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/auth/login') return next();
    if (req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: 'Cross-site request rejected.' });
    }
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) {
          return res.status(403).json({ error: 'Cross-origin request rejected.' });
        }
      } catch {
        return res.status(403).json({ error: 'Invalid request origin.' });
      }
    }
    next();
  });
  app.use('/api', createRoutes({ store, whatsapp, scheduler, auth }));
  app.use(express.static(publicDir, { index: 'index.html', maxAge: '1h' }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, _req, res, _next) => {
    const status = error?.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({ error: status === 400 ? 'Invalid JSON body.' : 'Unexpected server error.' });
  });
  return app;
}
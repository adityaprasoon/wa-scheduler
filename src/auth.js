import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const cookieName = 'wa_scheduler_session';
const sessionLifetimeMs = 12 * 60 * 60 * 1000;

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

export function createAuth({ password, secureCookie = false }) {
  if (typeof password !== 'string' || password.length < 16) {
    throw new Error('APP_PASSWORD must contain at least 16 characters.');
  }

  const expectedDigest = digest(password);
  const sessions = new Map();
  const attempts = new Map();

  function requireAuth(req, res, next) {
    const token = readCookie(req.headers.cookie, cookieName);
    const expiresAt = token && sessions.get(token);
    if (!expiresAt || expiresAt <= Date.now()) {
      if (token) sessions.delete(token);
      return res.status(401).json({ error: 'Authentication required.' });
    }
    sessions.set(token, Date.now() + sessionLifetimeMs);
    next();
  }

  function login(req, res) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const record = attempts.get(ip);
    if (record?.blockedUntil > now) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }

    const passwordValue = typeof req.body?.password === 'string' ? req.body.password : '';
    const matches = timingSafeEqual(digest(passwordValue), expectedDigest);
    if (!matches) {
      const failures = record?.windowStart > now - 15 * 60 * 1000 ? record.failures + 1 : 1;
      attempts.set(ip, {
        failures,
        windowStart: failures === 1 ? now : record.windowStart,
        blockedUntil: failures >= 8 ? now + 15 * 60 * 1000 : 0,
      });
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    attempts.delete(ip);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, now + sessionLifetimeMs);
    const secure = secureCookie ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeMs / 1000}${secure}`,
    );
    return res.json({ authenticated: true });
  }

  function logout(req, res) {
    const token = readCookie(req.headers.cookie, cookieName);
    if (token) sessions.delete(token);
    const secure = secureCookie ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
    return res.json({ authenticated: false });
  }

  return { requireAuth, login, logout };
}
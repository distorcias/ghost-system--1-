import express from 'express';
import crypto from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = (process.env.DUCKMAIL_API_URL || 'https://api.duckmail.sbs').replace(/\/$/, '');
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const REMEMBER_MS = 24 * 3600e3; // o token do DuckMail dura ~24h
const SHORT_MS = 8 * 3600e3;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID = /^[\w-]{1,100}$/;
const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) { console.error('Defina SESSION_SECRET com 32+ caracteres.'); if (PROD) throw new Error('SESSION_SECRET ausente'); }
const KEY = crypto.createHash('sha256').update(SECRET || 'dev-only-insecure-secret').digest();
// Sessão sem estado: { token, address, exp } criptografado (AES-256-GCM) dentro do cookie HttpOnly.
function seal(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function unseal(v) {
  try {
    const b = Buffer.from(v, 'base64url'), d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }
}
const fails = new Map();    // (por instância) ip -> [timestamps]

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '4kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  });
  next();
});
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));

const sidOf = (req) => /(?:^|;\s*)gs_sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
const sameOrigin = (req) => { try { return new URL(req.get('origin')).host === req.get('host'); } catch { return false; } };
const dm = (p, token, opt = {}) => fetch(API + p, { ...opt, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
const clearCookie = (res) => res.clearCookie('gs_sid', { httpOnly: true, secure: PROD, sameSite: 'strict', path: '/' });
const recentFails = (ip) => { const a = (fails.get(ip) || []).filter((t) => Date.now() - t < 900e3); fails.set(ip, a); return a; };

function auth(req, res, next) {
  const sid = sidOf(req), s = sid && unseal(sid);
  if (!s || !s.token || s.exp < Date.now()) { clearCookie(res); return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' }); }
  req.s = s; next();
}
function upstreamError(req, res, r) {
  if (r.status === 401) { clearCookie(res); return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' }); }
  if (r.status === 404) return res.status(404).json({ error: 'Mensagem não encontrada.' });
  if (r.status === 429) { res.set('Retry-After', r.headers.get('retry-after') || '30'); return res.status(429).json({ error: 'Muitas requisições. Aguarde um instante.' }); }
  return res.status(502).json({ error: 'Serviço de e-mail indisponível no momento.' });
}

app.post('/api/login', async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Origem da requisição inválida.' });
  const { address, password, remember } = req.body || {};
  if (typeof address !== 'string' || typeof password !== 'string' || address.length > 254 || !EMAIL.test(address.trim()) || !password || password.length > 200)
    return res.status(400).json({ error: 'Informe um e-mail válido e a senha.' });
  if (recentFails(req.ip).length >= 8) { res.set('Retry-After', '900'); return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' }); }
  try {
    const r = await fetch(API + '/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address.trim().toLowerCase(), password }), signal: AbortSignal.timeout(10000) });
    if (r.status === 429) return res.status(429).json({ error: 'Serviço limitando acessos. Tente novamente em instantes.' });
    if (!r.ok) {
      if (r.status < 500) { recentFails(req.ip).push(Date.now()); return res.status(401).json({ error: 'E-mail ou senha incorretos.' }); }
      throw new Error('upstream');
    }
    const { token } = await r.json();
    const me = await dm('/me', token);
    if (!token || !me.ok) throw new Error('upstream');
    const info = await me.json();
    const ttl = remember ? REMEMBER_MS : SHORT_MS;
    res.cookie('gs_sid', seal({ token, address: info.address, exp: Date.now() + ttl }), { httpOnly: true, secure: PROD, sameSite: 'strict', path: '/', ...(remember ? { maxAge: ttl } : {}) });
    res.json({ address: info.address });
  } catch {
    res.status(502).json({ error: 'Não foi possível contatar o serviço de e-mail.' });
  }
});

app.post('/api/logout', (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Origem da requisição inválida.' });
  clearCookie(res); res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ address: req.s.address }));

app.get('/api/messages', auth, async (req, res) => {
  const page = Math.min(1000, Math.max(1, parseInt(req.query.page) || 1));
  try {
    const r = await dm(`/messages?page=${page}`, req.s.token);
    if (!r.ok) return upstreamError(req, res, r);
    const d = await r.json();
    res.json({ page, total: d['hydra:totalItems'] ?? 0, items: (d['hydra:member'] || []).map((m) => ({
      id: m.id, from: m.from, subject: m.subject, seen: !!m.seen, createdAt: m.createdAt, hasAttachments: !!m.hasAttachments })) });
  } catch { res.status(502).json({ error: 'Serviço de e-mail indisponível no momento.' }); }
});

app.get('/api/messages/:id', auth, async (req, res) => {
  if (!ID.test(req.params.id)) return res.status(400).json({ error: 'Identificador inválido.' });
  try {
    const r = await dm(`/messages/${req.params.id}`, req.s.token);
    if (!r.ok) return upstreamError(req, res, r);
    const m = await r.json();
    const raw = Array.isArray(m.html) ? m.html.join('') : m.html || '';
    const html = raw && sanitizeHtml(raw, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'center']),
      allowedAttributes: { a: ['href', 'name'], img: ['src', 'alt', 'width', 'height'], '*': ['align'] },
      allowedSchemes: ['http', 'https', 'mailto'], allowedSchemesByTag: { img: ['data', 'https'] },
      transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }) },
    });
    dm(`/messages/${req.params.id}`, req.s.token, { method: 'PATCH' }).catch(() => {});
    res.json({ id: m.id, from: m.from, to: m.to, subject: m.subject, createdAt: m.createdAt, text: m.text || '', html,
      attachments: (m.attachments || []).map((a) => ({ filename: a.filename, size: a.size })) });
  } catch { res.status(502).json({ error: 'Serviço de e-mail indisponível no momento.' }); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
if (!process.env.VERCEL) app.listen(PORT, () => console.log(`Ghost System em http://localhost:${PORT}`));
export default app;

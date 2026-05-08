// Energía Vital — Node server with Postgres-backed auth + state API
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-please-set';
const NODE_ENV = process.env.NODE_ENV || 'production';

if (!DATABASE_URL) {
  console.warn('[WARN] DATABASE_URL not set — API endpoints will fail.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && /railway|neon|render|supabase/.test(DATABASE_URL)
    ? { rejectUnauthorized: false } : undefined,
  max: 10
});

// --------------------------------------------------------------------
// DB init + seed
// --------------------------------------------------------------------
async function initDB() {
  if (!DATABASE_URL) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
  `);

  // Cleanup expired sessions opportunistically (cheap, runs once at startup)
  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');

  // Seed demo user if missing
  const r = await pool.query('SELECT id FROM users WHERE email = $1', ['victor@unabase.com']);
  if (r.rows.length === 0) {
    const hash = hashPassword('123456');
    await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)',
      ['victor@unabase.com', hash, 'Víctor']
    );
    console.log('[init] demo user seeded');
  }
  console.log('[init] db ready');
}

// --------------------------------------------------------------------
// Auth helpers
// --------------------------------------------------------------------
function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(pwd, salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}
function verifyPassword(pwd, hashed) {
  if (!hashed) return false;
  const parts = hashed.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const expected = crypto.scryptSync(pwd, parts[1], 64);
    const actual = Buffer.from(parts[2], 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }

async function createSession(userId) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30d
  await pool.query(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [token, userId, expiresAt]
  );
  return { token, expiresAt };
}
async function getSession(token) {
  if (!token) return null;
  const r = await pool.query(
    `SELECT s.user_id, s.expires_at, u.email, u.name
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  );
  return r.rows[0] || null;
}
async function deleteSession(token) {
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

// --------------------------------------------------------------------
// AI: parse voice note into structured items via Claude Haiku
// --------------------------------------------------------------------
const VOICE_SYSTEM_PROMPT = `Eres un parser para ViveApp, una app de seguimiento personal. El usuario te contará en español qué hizo en su día con una nota de voz transcrita. Tu trabajo es extraer items concretos y devolver SOLO un objeto JSON (sin texto adicional, sin markdown, sin explicación).

Estructura del JSON (omite las keys que NO se mencionen):
{
  "meals": [{"desc": "descripción de la comida", "quality": "saludable|regular|procesada|snack|basura"}],
  "sleepHours": número entre 0 y 24,
  "exercise": [{"type": "bajo|alto|gym|otro", "label": "qué hizo"}],
  "relations": [{"type": "circulo|otro", "who": "nombre", "what": "qué hicieron juntos"}],
  "yo": [{"what": "actividad para sí mismo", "minutes": número estimado de minutos}],
  "goals": [{"text": "objetivo cumplido", "category": "trabajo|personal|familia|vida", "importance": "vital|importante|noimp"}]
}

Reglas de calidad de comida:
- "saludable" = balanceada, frutas/verduras, proteína sin frituras
- "regular" = comida normal sin destacar
- "procesada" = fast food, comida envasada
- "snack" = solo café, té, picadita
- "basura" = comida muy procesada, alcohol excesivo, dulces

Reglas de ejercicio:
- "bajo" = caminar, paseo, movimiento ligero
- "alto" = correr, intensidad cardiovascular alta
- "gym" = sesión completa de gimnasio
- "otro" = deporte estructurado (fútbol, tenis, etc.)

Reglas de relaciones:
- "circulo" = familia íntima (esposa, hijos, padres, hermanos)
- "otro" = amigos, vecinos, colegas, conocidos

Reglas de objetivos (goals):
- Solo cosas que el usuario CUMPLIÓ/TERMINÓ ("cerré la propuesta", "entregué el informe")
- categorías: trabajo, personal (cosas para sí mismo), familia, vida (recados, salud, casa)
- importancia: vital (crítico), importante (significativo), noimp (menor)

IMPORTANTE: Devuelve SOLO el JSON, nada más. No agregues explicaciones, comentarios, ni código markdown. Empieza con { y termina con }.`;

async function parseVoiceNote(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: VOICE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }]
    })
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`anthropic ${r.status}: ${errText.slice(0, 200)}`);
  }
  const j = await r.json();
  const content = j.content && j.content[0] && j.content[0].text;
  if (!content) throw new Error('respuesta vacía de la IA');

  // Extract first balanced JSON object from the response
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON en respuesta IA');
  let parsed;
  try { parsed = JSON.parse(m[0]); }
  catch (e) { throw new Error('JSON inválido: ' + e.message); }

  // Sanitize: only known keys, only allowed values
  const out = {};
  const allowedQuality = new Set(['saludable', 'regular', 'procesada', 'snack', 'basura']);
  const allowedExType = new Set(['bajo', 'alto', 'gym', 'otro']);
  const allowedRelType = new Set(['circulo', 'otro']);
  const allowedCat = new Set(['trabajo', 'personal', 'familia', 'vida']);
  const allowedImp = new Set(['vital', 'importante', 'noimp']);

  if (Array.isArray(parsed.meals)) {
    out.meals = parsed.meals
      .filter(m => m && typeof m === 'object' && allowedQuality.has(m.quality))
      .map(m => ({ desc: String(m.desc || '').slice(0, 200), quality: m.quality }))
      .slice(0, 10);
  }
  if (typeof parsed.sleepHours === 'number' && parsed.sleepHours >= 0 && parsed.sleepHours <= 24) {
    out.sleepHours = Math.round(parsed.sleepHours * 2) / 2; // half-hour precision
  }
  if (Array.isArray(parsed.exercise)) {
    out.exercise = parsed.exercise
      .filter(e => e && typeof e === 'object' && allowedExType.has(e.type))
      .map(e => ({ type: e.type, label: String(e.label || '').slice(0, 100) }))
      .slice(0, 5);
  }
  if (Array.isArray(parsed.relations)) {
    out.relations = parsed.relations
      .filter(r => r && typeof r === 'object' && allowedRelType.has(r.type))
      .map(r => ({
        type: r.type,
        who: String(r.who || '—').slice(0, 100),
        what: String(r.what || 'momento compartido').slice(0, 200)
      }))
      .slice(0, 10);
  }
  if (Array.isArray(parsed.yo)) {
    out.yo = parsed.yo
      .filter(y => y && typeof y === 'object' && y.what)
      .map(y => ({
        what: String(y.what).slice(0, 200),
        minutes: typeof y.minutes === 'number' ? Math.max(5, Math.min(600, Math.round(y.minutes))) : 30
      }))
      .slice(0, 5);
  }
  if (Array.isArray(parsed.goals)) {
    out.goals = parsed.goals
      .filter(g => g && typeof g === 'object' && g.text && allowedCat.has(g.category) && allowedImp.has(g.importance))
      .map(g => ({
        text: String(g.text).slice(0, 300),
        category: g.category,
        importance: g.importance
      }))
      .slice(0, 10);
  }
  return out;
}

// --------------------------------------------------------------------
// HTTP helpers
// --------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}
function setCookie(res, name, value, opts = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (typeof opts.maxAge === 'number') c += `; Max-Age=${opts.maxAge}`;
  if (opts.expires) c += `; Expires=${opts.expires.toUTCString()}`;
  if (opts.secure || NODE_ENV === 'production') c += '; Secure';
  res.setHeader('Set-Cookie', c);
}
function readBody(req, max = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''; let too = false;
    req.on('data', chunk => {
      if (too) return;
      body += chunk;
      if (body.length > max) { too = true; reject(new Error('body too large')); }
    });
    req.on('end', () => { if (!too) resolve(body); });
    req.on('error', reject);
  });
}
async function readJson(req) {
  try { const b = await readBody(req); return b ? JSON.parse(b) : {}; }
  catch { return null; }
}
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// --------------------------------------------------------------------
// API
// --------------------------------------------------------------------
async function handleApi(req, res, pathname) {
  const cookies = parseCookies(req);
  const session = await getSession(cookies.session);

  // POST /api/auth/register
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { error: 'invalid json' });
    const email = String(body.email || '').toLowerCase().trim();
    const password = String(body.password || '');
    const name = String(body.name || email.split('@')[0] || 'Usuario').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'email inválido' });
    if (password.length < 4) return sendJson(res, 400, { error: 'contraseña muy corta (mínimo 4)' });
    const exists = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (exists.rows.length) return sendJson(res, 409, { error: 'email ya registrado' });
    const hash = hashPassword(password);
    const r = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email, hash, name]
    );
    const user = r.rows[0];
    const { token, expiresAt } = await createSession(user.id);
    setCookie(res, 'session', token, { expires: expiresAt });
    return sendJson(res, 200, { user });
  }

  // POST /api/auth/login
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { error: 'invalid json' });
    const email = String(body.email || '').toLowerCase().trim();
    const password = String(body.password || '');
    const r = await pool.query('SELECT id, email, name, password_hash FROM users WHERE email = $1', [email]);
    const u = r.rows[0];
    if (!u || !verifyPassword(password, u.password_hash)) {
      return sendJson(res, 401, { error: 'email o contraseña incorrectos' });
    }
    const { token, expiresAt } = await createSession(u.id);
    setCookie(res, 'session', token, { expires: expiresAt });
    return sendJson(res, 200, { user: { id: u.id, email: u.email, name: u.name } });
  }

  // POST /api/auth/logout
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    if (cookies.session) await deleteSession(cookies.session);
    setCookie(res, 'session', '', { maxAge: 0 });
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/auth/me
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    if (!session) return sendJson(res, 401, { error: 'no autenticado' });
    return sendJson(res, 200, { user: { id: session.user_id, email: session.email, name: session.name } });
  }

  // GET /api/state
  if (pathname === '/api/state' && req.method === 'GET') {
    if (!session) return sendJson(res, 401, { error: 'no autenticado' });
    const r = await pool.query('SELECT state, updated_at FROM app_state WHERE user_id = $1', [session.user_id]);
    if (!r.rows.length) return sendJson(res, 200, { state: null, updated_at: null });
    return sendJson(res, 200, { state: r.rows[0].state, updated_at: r.rows[0].updated_at });
  }

  // PUT /api/state
  if (pathname === '/api/state' && req.method === 'PUT') {
    if (!session) return sendJson(res, 401, { error: 'no autenticado' });
    const body = await readJson(req);
    if (!body || typeof body.state !== 'object' || body.state === null) {
      return sendJson(res, 400, { error: 'state required' });
    }
    await pool.query(
      `INSERT INTO app_state (user_id, state, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [session.user_id, body.state]
    );
    return sendJson(res, 200, { ok: true, updated_at: new Date().toISOString() });
  }

  // POST /api/voice — parse a Spanish voice note into structured items
  if (pathname === '/api/voice' && req.method === 'POST') {
    if (!session) return sendJson(res, 401, { error: 'no autenticado' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return sendJson(res, 503, { error: 'IA no configurada en el servidor (falta ANTHROPIC_API_KEY)' });
    }
    const body = await readJson(req);
    if (!body || !body.text) return sendJson(res, 400, { error: 'text required' });
    const text = String(body.text).slice(0, 5000).trim();
    if (!text) return sendJson(res, 400, { error: 'text vacío' });
    try {
      const extracted = await parseVoiceNote(text);
      return sendJson(res, 200, { extracted });
    } catch (e) {
      console.error('[voice] parse error:', e);
      return sendJson(res, 500, { error: 'parse falló: ' + (e.message || 'unknown') });
    }
  }

  // GET /api/health
  if (pathname === '/api/health' && req.method === 'GET') {
    try {
      await pool.query('SELECT 1');
      return sendJson(res, 200, { ok: true, db: 'connected' });
    } catch (e) {
      return sendJson(res, 500, { ok: false, db: 'error', error: String(e.message || e) });
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

// --------------------------------------------------------------------
// Static
// --------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8'
};
const HEADERS_BASE = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function safeJoin(root, target) {
  const resolved = path.normalize(path.join(root, target));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const filePath = safeJoin(ROOT, pathname);
  if (!filePath) {
    res.writeHead(400, HEADERS_BASE);
    return res.end('Bad Request');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      const fallback = path.join(ROOT, 'index.html');
      fs.readFile(fallback, (e, data) => {
        if (e) { res.writeHead(404, HEADERS_BASE); return res.end('Not Found'); }
        res.writeHead(200, { ...HEADERS_BASE, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }
    fs.readFile(filePath, (e, data) => {
      if (e) { res.writeHead(500, HEADERS_BASE); return res.end('Server Error'); }
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const cache = (ext === '.html' || ext === '.json') ? 'no-cache' : 'public, max-age=86400';
      res.writeHead(200, { ...HEADERS_BASE, 'Content-Type': type, 'Cache-Control': cache });
      res.end(data);
    });
  });
}

// --------------------------------------------------------------------
// Server
// --------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent(url.parse(req.url).pathname || '/');
  if (pathname.startsWith('/api/')) {
    try { await handleApi(req, res, pathname); }
    catch (e) {
      console.error('[api] error:', e);
      try { sendJson(res, 500, { error: 'server error' }); } catch {}
    }
    return;
  }
  serveStatic(req, res, pathname);
});

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => console.log(`Energía Vital on http://0.0.0.0:${PORT}`));
}).catch(e => {
  console.error('[boot] DB init failed:', e);
  // start server anyway so /api/health can report the issue
  server.listen(PORT, '0.0.0.0', () => console.log(`Energía Vital on ${PORT} (DB FAILED)`));
});

process.on('SIGTERM', () => { console.log('SIGTERM'); server.close(() => pool.end()); });

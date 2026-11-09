// Zero-dependency server: only Node built-ins (http, crypto, fs, sqlite).
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { q, getBalance, applyTransaction } = require('./db');
const { notify, eur, replyText, runDigest } = require('./messaging');

const STAFF_PIN = process.env.STAFF_PIN || '1234';
const DEFAULT_COUNTRY_PREFIX = '+39'; // Italy
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- helpers ----------

/** Normalise an Italian-style number to E.164. Accepts "333 123 4567", "+39 333...", "0039333...". */
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s\-().]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) p = DEFAULT_COUNTRY_PREFIX + p;
  if (!/^\+\d{8,15}$/.test(p)) return null;
  return p;
}

/** "12.50" or "12,50" -> 1250 cents. Returns null if invalid. */
function parseEuros(raw) {
  const s = String(raw ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return cents > 0 ? cents : null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const publicCustomer = (c, balance_cents) => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  consent: !!c.consent,
  balance_cents,
  balance: eur(balance_cents),
});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 50_000) { reject(new HttpError(413, 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res) {
  const urlPath = new URL(req.url, 'http://x').pathname;
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- WhatsApp webhook (customer messages us -> free 24h window) ----------

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 200_000) { reject(new HttpError(413, 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function onCustomerMessage(from, text) {
  const restaurant = process.env.RESTAURANT_NAME || 'Our Restaurant';
  const customer = q.customerByPhone.get('+' + from);
  if (!customer) {
    const stranger = { id: 0, phone: '+' + from };
    return replyText(stranger, `Hi! We couldn't find this number at ${restaurant}. Please ask our staff to register you.`);
  }
  q.touchInbound.run(customer.id); // opens the free 24h window

  let body;
  if (/^\s*stop\s*$/i.test(text || '')) {
    q.updateConsent.run(0, customer.id);
    body = 'Done. You will no longer receive balance messages. You can still message us "balance" any time.';
  } else {
    body = `Hi ${customer.name.split(' ')[0]}, your credit balance at ${restaurant} is ${eur(getBalance(customer.id))}. ` +
      'Message us anytime to check it. Reply STOP to stop automatic updates.';
  }
  try {
    const ref = await replyText(customer, body);
    q.logMessage.run(customer.id, null, 'whatsapp reply (free)', body, ref === 'dry-run' ? 'dry-run' : 'sent', String(ref));
  } catch (e) {
    q.logMessage.run(customer.id, null, 'whatsapp reply (free)', body, 'failed', e.message);
  }
}

async function handleWebhook(req, res, url) {
  if (req.method === 'GET') { // Meta's one-time verification handshake
    const token = process.env.WHATSAPP_VERIFY_TOKEN || '';
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && token &&
      safeEqual(url.searchParams.get('hub.verify_token') || '', token);
    if (!ok) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(url.searchParams.get('hub.challenge') || '');
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

  const raw = await readRaw(req);
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (secret) {
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (!safeEqual(req.headers['x-hub-signature-256'] || '', expected)) throw new HttpError(401, 'Bad signature');
  } else if ((process.env.MESSAGE_PROVIDER || 'dry-run') !== 'dry-run') {
    throw new HttpError(401, 'WHATSAPP_APP_SECRET is required to accept webhooks');
  }

  res.writeHead(200); res.end(); // answer Meta immediately, then process
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return; }
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const m of change.value?.messages || []) {
        onCustomerMessage(String(m.from), m.type === 'text' ? m.text?.body : '').catch((e) => console.error('webhook error', e.message));
      }
    }
  }
}

// ---------- API handlers ----------

async function handleMovement(req, res, id, kind, staff) {
  const body = await readJson(req);
  const c = q.customerById.get(id);
  if (!c) throw new HttpError(404, 'Customer not found');
  const cents = parseEuros(body.amount);
  if (!cents) throw new HttpError(400, 'Enter a valid amount, e.g. 25 or 12.50');
  if (cents > 1_000_000) throw new HttpError(400, 'Amount too large');

  let r;
  try {
    r = applyTransaction({
      customerId: c.id,
      amountCents: kind === 'topup' ? cents : -cents,
      kind,
      note: String(body.note || '').slice(0, 200),
      staff,
    });
  } catch (e) {
    if (e.code === 'INSUFFICIENT') throw new HttpError(409, `Insufficient credit. Balance is ${eur(e.balance_cents)}.`);
    throw e;
  }
  const message = await notify({
    customer: c,
    transactionId: r.transactionId,
    kind,
    amountCents: cents,
    balanceCents: r.balanceCents,
  });
  sendJson(res, 200, {
    customer: publicCustomer(c, r.balanceCents),
    transaction_id: r.transactionId,
    message: { status: message.status, preview: message.body },
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  if (p === '/webhook/whatsapp') return handleWebhook(req, res, url);
  if (!p.startsWith('/api/')) return serveStatic(req, res);

  // Auth for every API call (login included: it just validates the PIN)
  const pinOk = safeEqual(req.headers['x-staff-pin'] || '', STAFF_PIN);
  if (p === '/api/login') {
    const b = await readJson(req);
    if (!safeEqual(b.pin || '', STAFF_PIN)) throw new HttpError(401, 'Wrong PIN');
    return sendJson(res, 200, { ok: true });
  }
  if (!pinOk) throw new HttpError(401, 'Wrong PIN');
  const staff = String(req.headers['x-staff-name'] || 'staff').slice(0, 40);

  if (p === '/api/customers' && m === 'GET') {
    const term = `%${(url.searchParams.get('q') || '').trim()}%`;
    return sendJson(res, 200, q.search.all(term, term).map((c) => publicCustomer(c, c.balance_cents)));
  }

  if (p === '/api/customers' && m === 'POST') {
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    const phone = normalizePhone(b.phone);
    if (!name) throw new HttpError(400, 'Name is required');
    if (!phone) throw new HttpError(400, 'Invalid phone number');
    if (q.customerByPhone.get(phone)) throw new HttpError(409, 'This phone number is already registered');
    const info = q.insertCustomer.run(phone, name, b.consent ? 1 : 0);
    return sendJson(res, 201, publicCustomer(q.customerById.get(Number(info.lastInsertRowid)), 0));
  }

  const mm = p.match(/^\/api\/customers\/(\d+)\/(topup|charge|history|consent)$/);
  if (mm) {
    const id = Number(mm[1]);
    const action = mm[2];
    if ((action === 'topup' || action === 'charge') && m === 'POST') return handleMovement(req, res, id, action, staff);

    if (action === 'history' && m === 'GET') {
      const c = q.customerById.get(id);
      if (!c) throw new HttpError(404, 'Customer not found');
      return sendJson(res, 200, {
        customer: publicCustomer(c, getBalance(c.id)),
        transactions: q.history.all(c.id, 50).map((t) => ({ ...t, amount: eur(t.amount_cents) })),
        messages: q.messages.all(c.id, 20),
      });
    }

    if (action === 'consent' && m === 'PATCH') {
      const b = await readJson(req);
      const c = q.customerById.get(id);
      if (!c) throw new HttpError(404, 'Customer not found');
      q.updateConsent.run(b.consent ? 1 : 0, c.id);
      return sendJson(res, 200, publicCustomer(q.customerById.get(c.id), getBalance(c.id)));
    }
  }

  throw new HttpError(404, 'Not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Something went wrong' });
  });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Restaurant credit running on http://localhost:${PORT}`);
    console.log(`Messages: ${process.env.MESSAGE_PROVIDER || 'dry-run'} (mode: ${process.env.NOTIFY_MODE || 'daily'})`);
    // Daily-summary messages: check every 5 minutes (also catches up after the computer was off).
    const tick = () => runDigest().catch((e) => console.error('digest error', e.message));
    setTimeout(tick, 5_000);
    setInterval(tick, 5 * 60_000).unref();
    if (STAFF_PIN === '1234') console.warn('WARNING: using default staff PIN. Set STAFF_PIN in .env');
  });
}

module.exports = { server, normalizePhone, parseEuros };

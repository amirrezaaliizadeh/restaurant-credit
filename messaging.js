/**
 * Balance messages. Providers (set MESSAGE_PROVIDER in .env):
 *   dry-run         -> prints the message to the console (default, safe for testing)
 *   twilio-sms      -> SMS via Twilio (simplest for Italy, no template approval)
 *   whatsapp-cloud  -> WhatsApp via Meta Cloud API directly (cheapest: no middleman fee)
 *   twilio-whatsapp -> WhatsApp via Twilio. Business-initiated messages must use
 *                      a Meta-approved template (set TWILIO_WHATSAPP_CONTENT_SID).
 *
 * No SDK needed: Twilio's REST API is called with fetch.
 */
const { q } = require('./db');

const RESTAURANT = process.env.RESTAURANT_NAME || 'Our Restaurant';

function eur(cents) {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

function buildMessage({ customer, kind, amountCents, balanceCents }) {
  const amount = eur(Math.abs(amountCents));
  const balance = eur(balanceCents);
  const first = customer.name.split(' ')[0];
  if (kind === 'topup') return `Added: ${amount}\nBalance: ${balance}`;
  if (kind === 'charge') return `Deducted: ${amount}\nRemaining balance: ${balance}`;
  return `Adjusted: ${amount}\nBalance: ${balance}`;
}

async function twilioRequest(form) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Twilio error ${res.status}`);
  return data.sid;
}

/** True if the customer messaged us in the last 24h (free-form messages are free in this window). */
function windowOpen(customer) {
  if (!customer.last_inbound_at) return false;
  const t = Date.parse(customer.last_inbound_at.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) && Date.now() - t < 24 * 3600 * 1000;
}

/**
 * Meta WhatsApp Cloud API, called directly (no middleman, cheapest option).
 * Inside the customer's 24h window we send plain text (free); outside we send the approved template.
 */
async function metaWhatsApp(customer, vars, body, freeText) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const template = process.env.WHATSAPP_TEMPLATE_NAME;
  if (!token || !phoneId || (!freeText && !template)) {
    throw new Error('Missing WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TEMPLATE_NAME');
  }
  const payload = freeText
    ? { messaging_product: 'whatsapp', to: customer.phone.replace('+', ''), type: 'text', text: { body } }
    : {
      messaging_product: 'whatsapp',
      to: customer.phone.replace('+', ''),
      type: 'template',
      template: {
        name: template,
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
        components: [
          {
            type: 'body',
            // Template body variables: {{1}} first name, {{2}} amount, {{3}} balance
            parameters: [vars[1], vars[2], vars[3]].map((text) => ({ type: 'text', text })),
          },
        ],
      },
    };
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `WhatsApp error ${res.status}`);
  return data.messages?.[0]?.id || 'sent';
}

/** Plain-text reply to a customer who just messaged us (free inside the 24h window). */
async function replyText(customer, body) {
  const provider = process.env.MESSAGE_PROVIDER || 'dry-run';
  if (provider === 'whatsapp-cloud') return metaWhatsApp(customer, null, body, true);
  console.log(`[dry-run reply] -> ${customer.phone}: ${body}`);
  return 'dry-run';
}

async function send(provider, customer, body, vars) {
  switch (provider) {
    case 'whatsapp-cloud':
      // Free text inside the customer's 24h window, approved template otherwise.
      return metaWhatsApp(customer, vars, body, windowOpen(customer));
    case 'twilio-sms':
      return twilioRequest({ To: customer.phone, From: process.env.TWILIO_SMS_FROM, Body: body });
    case 'twilio-whatsapp': {
      const form = {
        To: `whatsapp:${customer.phone}`,
        From: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`,
      };
      if (process.env.TWILIO_WHATSAPP_CONTENT_SID) {
        // Approved template with variables: {{1}} name, {{2}} amount, {{3}} balance
        form.ContentSid = process.env.TWILIO_WHATSAPP_CONTENT_SID;
        form.ContentVariables = JSON.stringify(vars);
      } else {
        form.Body = body; // only delivered inside the 24h customer-service window
      }
      return twilioRequest(form);
    }
    default:
      console.log(`[dry-run] -> ${customer.phone}: ${body}`);
      return 'dry-run';
  }
}

const signedEur = (cents) => (cents < 0 ? '-' : '+') + eur(Math.abs(cents)); // e.g. "-37,50 €"

/**
 * Cost control. NOTIFY_MODE (what to send when the customer has NOT messaged us in the last 24h):
 *   every  -> one message per transaction
 *   charges-> only when credit is deducted (top-ups are silent)
 *   low    -> only top-ups, and deductions that leave the balance under LOW_BALANCE_EUR (default 20)
 *   daily  -> one summary message per customer per day (sent at NOTIFY_DAILY_HOUR, default 21)
 * Inside the free 24h window every change is sent immediately, in every mode (it costs nothing).
 */
const MODE = () => process.env.NOTIFY_MODE || 'charges';

function isFree(provider, customer) {
  return (provider === 'whatsapp-cloud' || provider === 'dry-run') && windowOpen(customer);
}

function wouldSend(mode, { kind, balanceCents }) {
  switch (mode) {
    case 'every': return true;
    case 'charges': return kind !== 'topup';
    case 'low': {
      const limit = Math.round(parseFloat(process.env.LOW_BALANCE_EUR || '20') * 100);
      return kind === 'topup' || balanceCents < limit;
    }
    default: return false; // 'daily' is handled by the digest
  }
}

/** Sends one message and logs it. Never throws: a messaging failure must not undo a ledger entry. */
async function deliver({ customer, transactionId, body, vars }) {
  const provider = process.env.MESSAGE_PROVIDER || 'dry-run';
  try {
    const ref = await send(provider, customer, body, vars);
    const status = provider === 'dry-run' ? 'dry-run' : 'sent';
    const channel = provider === 'whatsapp-cloud' ? (windowOpen(customer) ? 'whatsapp-cloud (free text)' : 'whatsapp-cloud (template)') : provider;
    q.logMessage.run(customer.id, transactionId, channel, body, status, String(ref));
    return { status, body };
  } catch (e) {
    q.logMessage.run(customer.id, transactionId, provider, body, 'failed', e.message);
    return { status: 'failed', body, error: e.message };
  }
}

async function notify({ customer, transactionId, kind, amountCents, balanceCents }) {
  const provider = process.env.MESSAGE_PROVIDER || 'dry-run';
  const body = buildMessage({ customer, kind, amountCents, balanceCents });

  if (!customer.consent) {
    q.logMessage.run(customer.id, transactionId, provider, body, 'skipped', 'No consent on file');
    return { status: 'skipped', body };
  }
  const mode = MODE();
  if (!isFree(provider, customer) && !wouldSend(mode, { kind, balanceCents })) {
    if (mode === 'daily') {
      q.markPending.run(transactionId); // will be included in tonight's summary
      q.logMessage.run(customer.id, transactionId, provider, body, 'queued', 'Included in daily summary');
      return { status: 'queued', body };
    }
    q.logMessage.run(customer.id, transactionId, provider, body, 'skipped', `Mode "${mode}": no message needed`);
    return { status: 'skipped', body };
  }
  const vars = { 1: customer.name.split(' ')[0], 2: signedEur(kind === 'charge' ? -amountCents : amountCents), 3: eur(balanceCents) };
  return deliver({ customer, transactionId, body, vars });
}

/**
 * Daily summary: one message per customer covering all unsent changes (net change + final balance).
 * Runs after NOTIFY_DAILY_HOUR, and also catches up on older leftovers if the computer was off.
 */
async function runDigest(now = new Date()) {
  const hour = parseInt(process.env.NOTIFY_DAILY_HOUR || '21', 10);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const { getBalance } = require('./db');
  let sent = 0;
  for (const p of q.pendingByCustomer.all()) {
    const firstAt = Date.parse(p.first_at.replace(' ', 'T') + 'Z');
    const due = now.getHours() >= hour || firstAt < startOfToday;
    if (!due) continue;
    const customer = q.customerById.get(p.customer_id);
    if (!customer?.consent) { q.markNotified.run(p.customer_id, p.last_id); continue; }
    const balanceCents = getBalance(customer.id);
    const first = customer.name.split(' ')[0];
    const change = p.net_cents === 0 ? eur(0) : signedEur(p.net_cents);
    const body = `Hi ${first}, today your credit at ${RESTAURANT} changed by ${change}. Your balance is now ${eur(balanceCents)}. Thank you!`;
    const r = await deliver({ customer, transactionId: null, body, vars: { 1: first, 2: change, 3: eur(balanceCents) } });
    if (r.status !== 'failed') { q.markNotified.run(p.customer_id, p.last_id); sent++; }
  }
  return sent;
}

module.exports = { notify, buildMessage, eur, replyText, windowOpen, runDigest };

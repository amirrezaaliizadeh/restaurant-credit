const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS customers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phone       TEXT NOT NULL UNIQUE,          -- E.164, e.g. +393331234567
    name        TEXT NOT NULL,
    consent     INTEGER NOT NULL DEFAULT 0,    -- 1 = agreed to receive balance messages
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- The ledger. Balance is ALWAYS the sum of this table (amounts in cents).
  -- Positive = top-up, negative = charge. Rows are never edited or deleted;
  -- mistakes are fixed with a new correcting row.
  CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents != 0),
    kind        TEXT NOT NULL CHECK (kind IN ('topup','charge','adjustment')),
    note        TEXT,
    staff       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tx_customer ON transactions(customer_id);

  CREATE TABLE IF NOT EXISTS message_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id    INTEGER NOT NULL REFERENCES customers(id),
    transaction_id INTEGER REFERENCES transactions(id),
    channel        TEXT NOT NULL,
    body           TEXT NOT NULL,
    status         TEXT NOT NULL,              -- sent | failed | skipped | dry-run
    detail         TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration: remember when each customer last messaged us (opens WhatsApp's free 24h window).
if (!db.prepare('PRAGMA table_info(customers)').all().some((c) => c.name === 'last_inbound_at')) {
  db.exec('ALTER TABLE customers ADD COLUMN last_inbound_at TEXT');
}

// Migration: transactions waiting to be included in a daily summary message (0 = pending).
if (!db.prepare('PRAGMA table_info(transactions)').all().some((c) => c.name === 'notified')) {
  db.exec('ALTER TABLE transactions ADD COLUMN notified INTEGER NOT NULL DEFAULT 1');
}

const q = {
  markPending: db.prepare('UPDATE transactions SET notified = 0 WHERE id = ?'),
  pendingByCustomer: db.prepare(`
    SELECT customer_id, SUM(amount_cents) AS net_cents, COUNT(*) AS n, MAX(id) AS last_id, MIN(created_at) AS first_at
    FROM transactions WHERE notified = 0 GROUP BY customer_id
  `),
  markNotified: db.prepare('UPDATE transactions SET notified = 1 WHERE customer_id = ? AND notified = 0 AND id <= ?'),
  touchInbound: db.prepare("UPDATE customers SET last_inbound_at = datetime('now') WHERE id = ?"),
  customerByPhone: db.prepare('SELECT * FROM customers WHERE phone = ?'),
  customerById: db.prepare('SELECT * FROM customers WHERE id = ?'),
  insertCustomer: db.prepare(
    'INSERT INTO customers (phone, name, consent) VALUES (?, ?, ?)'
  ),
  updateConsent: db.prepare('UPDATE customers SET consent = ? WHERE id = ?'),
  search: db.prepare(`
    SELECT c.*, COALESCE(SUM(t.amount_cents), 0) AS balance_cents
    FROM customers c LEFT JOIN transactions t ON t.customer_id = c.id
    WHERE c.phone LIKE ? OR c.name LIKE ?
    GROUP BY c.id ORDER BY c.name LIMIT 25
  `),
  balance: db.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS balance_cents FROM transactions WHERE customer_id = ?'
  ),
  insertTx: db.prepare(
    'INSERT INTO transactions (customer_id, amount_cents, kind, note, staff) VALUES (?, ?, ?, ?, ?)'
  ),
  history: db.prepare(
    'SELECT * FROM transactions WHERE customer_id = ? ORDER BY id DESC LIMIT ?'
  ),
  logMessage: db.prepare(
    'INSERT INTO message_log (customer_id, transaction_id, channel, body, status, detail) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  messages: db.prepare(
    'SELECT * FROM message_log WHERE customer_id = ? ORDER BY id DESC LIMIT ?'
  ),
};

function getBalance(customerId) {
  return q.balance.get(customerId).balance_cents;
}

/**
 * Apply a transaction atomically. Charges that would overdraw the account
 * are rejected unless allowNegative is true.
 */
function applyTransaction({ customerId, amountCents, kind, note, staff, allowNegative = false }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = getBalance(customerId);
    const next = current + amountCents;
    if (next < 0 && !allowNegative) {
      const err = new Error('Insufficient credit');
      err.code = 'INSUFFICIENT';
      err.balance_cents = current;
      throw err;
    }
    const info = q.insertTx.run(customerId, amountCents, kind, note || null, staff || null);
    db.exec('COMMIT');
    return { transactionId: Number(info.lastInsertRowid), balanceCents: next, previousCents: current };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, q, getBalance, applyTransaction };

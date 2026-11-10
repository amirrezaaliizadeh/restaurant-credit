# Restaurant Customer Credit (Italy)

Staff add or deduct prepaid credit for a customer (identified by mobile number).
After every change the customer automatically receives a message with their remaining balance.

- Zero dependencies (Node 22.13+ only: built-in HTTP server + SQLite).
- Mobile-friendly English staff panel, protected by a PIN.
- Balance is always computed from the transaction ledger (never a single stored number).
- Charges that would overdraw an account are rejected.
- Messages are only sent to customers who gave consent; every message is logged.

## Run it

```bash
cp .env.example .env     # then edit STAFF_PIN and RESTAURANT_NAME
npm start                # http://localhost:3000
```

Default `MESSAGE_PROVIDER=dry-run` prints messages to the console instead of sending them.
Test everything this way first.

## Turn on real messages

Create a Twilio account, then in `.env`:

**SMS (simplest in Italy, no template approval):**
```
MESSAGE_PROVIDER=twilio-sms
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_SMS_FROM=+39...
```

**WhatsApp, cheapest (Meta Cloud API directly, no Twilio fee):**
1. developers.facebook.com -> create a Business app -> add the WhatsApp product.
2. Add your restaurant's number (must not be registered on a normal WhatsApp app) and note the *Phone number ID*.
3. Create a permanent System User token (Business Settings -> System users) with `whatsapp_business_messaging`.
4. Create a **Utility** template named `credit_update`, language English, body:
   `Hi {{1}}, your credit at <Restaurant> changed by {{2}}. Your remaining balance is {{3}}. Thank you!`
   ({{2}} is signed, e.g. "-37,50 €" or "+100,00 €")
5. In `.env`:
```
MESSAGE_PROVIDER=whatsapp-cloud
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_TEMPLATE_NAME=credit_update
WHATSAPP_VERIFY_TOKEN=any-long-random-string
WHATSAPP_APP_SECRET=...   # App settings -> Basic -> App secret
```
6. Webhook (this is what makes messages free): in the Meta app, WhatsApp -> Configuration, set
   Callback URL `https://YOUR-DOMAIN/webhook/whatsapp` and the same verify token, and subscribe to `messages`.
   Your server needs a public HTTPS address (a free Cloudflare Tunnel works).

### Choosing how many messages to send (`NOTIFY_MODE`)
| Mode | What the customer gets (when they have NOT messaged you in 24h) |
|---|---|
| `daily` | One summary per day at `NOTIFY_DAILY_HOUR` (default 21): net change + balance |
| `charges` (default) | A message only when credit is deducted |
| `low` | Top-ups, and deductions that leave less than `LOW_BALANCE_EUR` |
| `every` | One message per transaction |

The summary is sent while the server is running; if the computer was off, it catches up the next time you start it.
Customers can always message "Balance" to check their credit for free (needs the webhook, see below).

### How to keep WhatsApp costs near zero
Free-form messages are free for 24h after the customer last messaged you. Inside that window the app
sends plain text; outside it, it falls back to the approved Utility template (small per-message fee).
- Put a QR code / `https://wa.me/39XXXXXXXXXX?text=Balance` link at the table or till.
- A customer who sends any message gets their balance back for free, and every top-up or deduction
  during the next 24h is free too.
- Replying `STOP` turns off automatic messages for that customer (they can still ask "balance").
- Unknown numbers get a short "please ask staff to register you" reply.

**WhatsApp via Twilio:** business-initiated messages must use a Meta-approved template.
Create a template with 3 variables (`{{1}}` first name, `{{2}}` amount, `{{3}}` balance), e.g.:
"Hi {{1}}, {{2}} was updated on your credit. Your balance is now {{3}}."
```
MESSAGE_PROVIDER=twilio-whatsapp
TWILIO_WHATSAPP_FROM=+39...
TWILIO_WHATSAPP_CONTENT_SID=HX...
```

## Going live checklist

- Host it on a small server (Railway, Render, Fly.io, or a VPS) behind HTTPS. Do not expose it over plain HTTP.
- Set a strong `STAFF_PIN`. Back up `data.db` regularly (it is one file).
- Get consent when registering a customer (the checkbox in the panel) and give them a way to opt out.
- Customer phone numbers are personal data under GDPR: keep only what you need and tell customers how it is used.
- Check whether holding prepaid customer funds has any tax or accounting implications for your restaurant with your accountant.

## Files

- `server.js` HTTP server and API
- `db.js` SQLite schema and atomic transactions
- `messaging.js` message text and providers (dry-run, Twilio SMS/WhatsApp, Meta WhatsApp Cloud)
- `public/index.html` staff panel
- `.env.example` settings template (copy to `.env`; never share the real `.env`)

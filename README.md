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

**WhatsApp:** business-initiated messages must use a Meta-approved template.
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
- `messaging.js` message text and providers (dry-run, Twilio SMS/WhatsApp)
- `public/index.html` staff panel

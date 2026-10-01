# Rental Portal

A small, cheap-to-host rental management web app for two landlords and a few tenants (one or two people per lease).

## What it does

**Tenants** (each person on a lease has their own login, sharing one balance):
- See what's due, what's coming (rent is scheduled through lease end), and every past charge and payment; print receipts and yearly statements.
- Pay by Cash App / Venmo (one-tap links with the amount filled in), Zelle, wire, check or cash, then report it; landlords confirm with one click.
- Open maintenance requests with photos and reply threads.
- View their lease and other documents, security-deposit ledger, and move-in/out inspection reports (and sign off on them).

**Landlords** (you and your spouse, separate logins and an activity log of who did what):
- Add tenants and extra people on a lease; set rent, due day, late fees, lease dates, insurance expiry.
- Recurring rent charges, automatic late fees, one-off charges and credits (utilities, HOA pass-throughs, repairs).
- Confirm or reject reported payments; record cash/check payments.
- Documents (leases, notices, house rules for everyone), photo-backed move-in/move-out inspections, security-deposit tracking.
- Ticket inbox with private landlord-only notes.
- Dashboard "needs attention": leases ending, insurance expiring, backups overdue.
- Finances: expense log with receipt photos, yearly income/expense summary, CSV export for taxes.
- Announcements (shown to tenants, optionally emailed), lease renewal / rent-change tool with history, a vendor directory with per-ticket repair cost tracking, and a tenant-facing "Your home" guide (trash day, parking, emergency contacts…).
- - **Property & listing**: description, details, amenities and a photo gallery (captions, cover photo, reorder, download all, printable sheet, copy-ready listing text) so the unit can be listed quickly later.
- Email notifications and rent reminders; password reset; optional two-factor sign-in; backups.

## Run locally
```
npm install
npm start        # http://localhost:3000  (first visit creates the first landlord account)
npm run demo     # throwaway sample data on http://localhost:3100 (logins printed on screen)
npm test         # four test suites: core, Stripe webhook, features, reminders
```
Requires Node 22.5+ (built-in SQLite, no database to install). Data lives in `./data` (database + uploaded files).

## Email (notifications, reminders, password reset)
Without email configured the app still works: tenants just aren't notified, and Settings shows what *would* have been sent. To turn it on, set `SMTP_URL`. For a regular Gmail account (turn on 2-step verification, then create an "App password"):
```
SMTP_URL=smtps://you%40gmail.com:YOUR_APP_PASSWORD@smtp.gmail.com
MAIL_FROM="Maple Court <you@gmail.com>"
```
Any SMTP provider works. Use Settings → "Send me a test email" to check it. Set **Public web address** in Settings (or `APP_URL`) so links in emails point at your site.
Emails sent: invites, password reset, payment reported / confirmed / rejected, new tickets and replies, inspection shared/reviewed, rent reminders (before due, on due date, 1 day and 7 days late), lease-ending (90/60/30 days) and insurance-expiring notices.

## Payments: how they work
Cash App and Venmo have no API for personal accounts, so an app can't see those payments. The flow is: tenant pays → clicks **"I've sent this payment"** → you confirm after checking your account. Per-tenant **auto-confirm** skips your click.
**Stripe bank debit (optional, off by default)** gives fully automatic payments (about 0.8%, max $5 each). It appears only if `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (and `APP_URL`) are set. Webhook URL: `https://YOUR-DOMAIN/webhooks/stripe`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`. Test in Stripe test mode first.

## Security
- Passwords hashed with scrypt; random hashed session tokens (httpOnly, SameSite=Lax, Secure on HTTPS, 14 days); login throttling; no account-enumeration on login or reset.
- Optional two-factor (authenticator app + 8 recovery codes) for any account. A landlord locked out can be reset by the other landlord.
- CSRF protection (same-origin check), strict CSP, HSTS, `no-store` on API responses.
- Tenants see only their own lease's data; enforced server-side and covered by tests. Uploads are type-checked by contents, stored under random names, and served with `nosniff` and a sandboxing CSP. CSV exports neutralise spreadsheet formulas.
- The app never stores card or bank numbers.
- Set `SETUP_CODE` when deploying so nobody else can claim the first landlord account. **Always use HTTPS** (every host below provides it).

## Backups (important)
A daily database snapshot is kept in `data/backups` (last 14). That protects against mistakes but not against losing the server's disk, so use **Settings → Download full backup** (database + all uploaded files, one `.tar`) regularly and keep it somewhere safe. The dashboard nags you if it's been more than 30 days. To restore: stop the app, put `rental.db` and the `docs` folder into the data directory.

## Deploy cheaply
Any host that runs Node or Docker with a **persistent disk**: Fly.io (~$0–3/mo), Railway (~$5/mo), or a $4–6 VPS. Avoid free tiers with ephemeral disks. A `Dockerfile` is included.

| Variable | Purpose |
|---|---|
| `NODE_ENV=production` | secure cookies |
| `SETUP_CODE` | required to create the first landlord |
| `DATA_DIR` | path to the persistent disk |
| `APP_URL` | public https address (links in emails) |
| `SMTP_URL`, `MAIL_FROM` | outgoing email |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | optional bank debit |

## Legal note
Late fees, deposit handling and return deadlines, entry notices and rules about fees for paying rent vary by state and city. This app lets you configure these but does not know your local law; check yours.

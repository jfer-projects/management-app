import Stripe from 'stripe';
import express from 'express';
import { db } from './db.js';
import { ledger, todayStr } from './billing.js';

const key = process.env.STRIPE_SECRET_KEY;
const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
export const stripeEnabled = !!(key && whSecret);
const stripe = stripeEnabled ? new Stripe(key) : null;

const upsert = db.prepare(`INSERT INTO payments(tenant_id,amount_cents,method,reference,paid_date,status,reviewed_at,stripe_session_id)
  VALUES(?,?,'ach',?,?,?,?,?)
  ON CONFLICT(stripe_session_id) WHERE stripe_session_id IS NOT NULL
  DO UPDATE SET status=excluded.status, reviewed_at=excluded.reviewed_at
  WHERE payments.status<>'confirmed'`);

function record(session, status) {
  const tenantId = Number(session.metadata?.tenant_id);
  if (!tenantId || !db.prepare("SELECT 1 FROM users WHERE id=? AND role='tenant'").get(tenantId)) return;
  upsert.run(tenantId, session.amount_total, `Stripe ${session.payment_intent || session.id}`, todayStr(), status,
    status === 'pending' ? null : new Date().toISOString(), session.id);
}

/** Must be mounted BEFORE express.json(): Stripe signatures need the raw body. */
export function mountWebhook(app) {
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    if (!stripeEnabled) return res.status(404).end();
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), whSecret); }
    catch { return res.status(400).send('Bad signature'); }

    const s = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
        // ACH is "unpaid" until the bank debit clears (several business days).
        record(s, s.payment_status === 'paid' ? 'confirmed' : 'pending'); break;
      case 'checkout.session.async_payment_succeeded': record(s, 'confirmed'); break;
      case 'checkout.session.async_payment_failed': record(s, 'rejected'); break;
    }
    res.json({ received: true });
  });
}

/** POST /api/stripe/checkout — tenant starts a bank-debit payment. */
export async function createCheckout(req, res, bad, cents) {
  if (!stripeEnabled) bad('Online bank payments are not set up', 503);
  const u = req.user;
  if (u.role !== 'tenant') bad('Tenant accounts only', 403);
  const amount = cents(req.body?.amount);
  const l = ledger(u.id);
  const max = Math.max(l.balance_cents, u.rent_cents);
  if (amount > max) bad(`Amount can't exceed ${(max / 100).toFixed(2)}`);
  if (amount < 50) bad('Minimum online payment is $0.50');

  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['us_bank_account'],
    payment_method_options: { us_bank_account: { financial_connections: { permissions: ['payment_method'] } } },
    customer_email: u.email,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: amount, product_data: { name: `Rent payment – ${u.name}` } } }],
    metadata: { tenant_id: String(u.id) },
    payment_intent_data: { metadata: { tenant_id: String(u.id) } },
    success_url: `${base}/#/ledger`,
    cancel_url: `${base}/#/`,
  });
  res.json({ url: session.url });
}

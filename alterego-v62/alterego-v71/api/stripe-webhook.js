import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { grantCreditsForSession } from '../lib/stripe-grant.js';

// ── /api/stripe-webhook ──────────────────────────────────────────────────────
// The safety net for purchases. If a user pays but closes the tab before the
// success page calls verify_payment, Stripe still POSTs checkout.session.completed
// here and we grant the credits. Shares the SAME idempotent grant helper as
// /api/stripe, so a purchase is granted exactly once no matter which path wins.
//
// This endpoint is NOT auth-gated by our JWT — it's called by Stripe, not the
// browser. Instead it is authenticated by verifying Stripe's signature against
// STRIPE_WEBHOOK_SECRET. An unsigned or wrongly-signed request is rejected.
//
// IMPORTANT: signature verification needs the RAW request body, so Vercel's
// automatic body parsing is disabled below.

export const config = {
  api: { bodyParser: false },
};

const STRIPE_SECRET = process.env.Stripe_secret_key;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Read the raw request body as a Buffer (bodyParser is off).
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Verify the Stripe-Signature header. Returns true if the v1 HMAC matches and
// the timestamp is within tolerance (5 min), false otherwise.
function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    })
  );
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return false;

  // Reject stale timestamps (replay protection).
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;

  const signedPayload = `${t}.${rawBody.toString('utf8')}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  // Constant-time compare.
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(v1, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Stripe sends checkout.session.completed without the full nested objects we
// need (metadata is present, but payment_status/amount can be expanded). Fetch
// the authoritative session to be safe.
async function fetchSession(sessionId) {
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { 'Authorization': `Bearer ${STRIPE_SECRET}` },
  });
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!WEBHOOK_SECRET) {
    console.error('stripe-webhook: STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Could not read body' });
  }

  const sig = req.headers['stripe-signature'];
  if (!verifyStripeSignature(rawBody, sig, WEBHOOK_SECRET)) {
    console.warn('stripe-webhook: signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // We only act on completed checkouts. Acknowledge everything else with 200 so
  // Stripe doesn't retry events we intentionally ignore.
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  try {
    const sessionId = event.data?.object?.id;
    if (!sessionId) return res.status(200).json({ received: true, note: 'no session id' });

    // Re-fetch the authoritative session (payment_status, amounts, metadata).
    const session = await fetchSession(sessionId);
    if (session.error) {
      console.error('stripe-webhook: session fetch error', session.error);
      return res.status(200).json({ received: true, note: 'session fetch failed' });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const result = await grantCreditsForSession(supabase, session);
    console.log('stripe-webhook grant:', JSON.stringify({
      session: sessionId, added: result.added, duplicate: result.duplicate, success: result.success
    }));

    // Always 200 on a handled event so Stripe marks it delivered. (Idempotency
    // means a retry is harmless anyway.)
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('stripe-webhook handler error:', err.message);
    // 500 → Stripe will retry, which is safe because granting is idempotent.
    return res.status(500).json({ error: err.message });
  }
}

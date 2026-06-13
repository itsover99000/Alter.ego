import { createClient } from '@supabase/supabase-js';
import { applyCors, requireUser } from '../lib/auth.js';
import { grantCreditsForSession } from '../lib/stripe-grant.js';

const STRIPE_SECRET = process.env.Stripe_secret_key;

async function stripeRequest(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
  };
  if (body) opts.body = new URLSearchParams(body).toString();
  const res = await fetch(`https://api.stripe.com/v1${path}`, opts);
  return res.json();
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Both actions require a signed-in user. For checkout, this guarantees the
  // userId stamped into Stripe metadata (which later determines who gets the
  // credits) is the authenticated caller — not an arbitrary id from the body.
  const auth = await requireUser(req, res);
  if (!auth) return;

  try {
    const { action, priceId, sessionId } = req.body;
    const userId = auth.userId;
    const userEmail = auth.user.email;

    // ── CREATE CHECKOUT SESSION ────────────────────────────
    if (action === 'create_checkout') {
      const session = await stripeRequest('/checkout/sessions', 'POST', {
        'payment_method_types[0]': 'card',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'mode': 'payment',
        'success_url': `https://alter-ego.photography/app/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        'cancel_url': `https://alter-ego.photography/app/?payment=cancelled`,
        'customer_email': userEmail,
        'metadata[userId]': userId,
        'metadata[priceId]': priceId,
      });
      if (session.error) return res.status(400).json({ error: session.error.message });
      return res.status(200).json({ url: session.url });
    }

    // ── VERIFY PAYMENT + ADD CREDITS + STAMP TIER ─────────
    // This is the "user returned to the success page" path. The webhook
    // (/api/stripe-webhook) is the safety net for when they don't. Both call
    // the SAME idempotent grant helper, so whichever runs first grants once and
    // the other is a no-op.
    if (action === 'verify_payment') {
      const session = await stripeRequest(`/checkout/sessions/${sessionId}`);
      if (session.error) return res.status(400).json({ error: session.error.message });
      if (session.payment_status !== 'paid') return res.status(400).json({ error: 'Payment not completed' });

      // Defence-in-depth: the session's userId must match the signed-in caller,
      // so one user can't claim another's checkout session.
      if (session.metadata?.userId && session.metadata.userId !== userId) {
        return res.status(403).json({ error: 'Session does not belong to this user' });
      }

      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      );

      const result = await grantCreditsForSession(supabase, session);
      if (!result.success) return res.status(400).json({ error: result.error });
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Stripe handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}

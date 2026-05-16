import { createClient } from '@supabase/supabase-js';

const STRIPE_SECRET = process.env.Stripe_secret_key;

const CREDIT_PACKS = {
  'price_1TXWyIHdibGBYkOdq8xDgdql': 10,
  'price_1TXX05HdibGBYkOdW5a0H0mN': 30,
  'price_1TXX0wHdibGBYkOddBgIC5oT': 100,
};

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // TEMP DEBUG
  console.log('ENV DEBUG:', {
    supabaseUrl: process.env.SUPABASE_URL || 'MISSING',
    serviceKey: process.env.SUPABASE_SERVICE_KEY ? 'EXISTS' : 'MISSING',
    stripeKey: process.env.Stripe_secret_key ? 'EXISTS' : 'MISSING',
  });

  try {
    const { action, priceId, userId, userEmail, sessionId } = req.body;

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

    // ── VERIFY PAYMENT + ADD CREDITS ──────────────────────
    if (action === 'verify_payment') {
      const session = await stripeRequest(`/checkout/sessions/${sessionId}`);
      if (session.error) return res.status(400).json({ error: session.error.message });
      if (session.payment_status !== 'paid') return res.status(400).json({ error: 'Payment not completed' });

      const uid = session.metadata?.userId;
      const pid = session.metadata?.priceId;
      const creditsToAdd = CREDIT_PACKS[pid];
      if (!creditsToAdd || !uid) return res.status(400).json({ error: 'Invalid session metadata' });

      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      );

      const { data: profile, error: fetchErr } = await supabase
        .from('profiles').select('credits').eq('id', uid).single();
      if (fetchErr) return res.status(500).json({ error: fetchErr.message });

      const newCredits = (profile.credits || 0) + creditsToAdd;
      const { error: updateErr } = await supabase
        .from('profiles').update({ credits: newCredits }).eq('id', uid);
      if (updateErr) return res.status(500).json({ error: updateErr.message });

      return res.status(200).json({ success: true, credits: newCredits, added: creditsToAdd });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Stripe handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}

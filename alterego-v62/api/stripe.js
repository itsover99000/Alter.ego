import { createClient } from '@supabase/supabase-js';

const STRIPE_SECRET = process.env.Stripe_secret_key;

const CREDIT_PACKS = {
  'price_1TXaqMHrmvKRw6joRElli2MC': 10,  // Starter
  'price_1TXaqNHrmvKRw6joLn6joNdC': 30,  // Creator
  'price_1TXaqNHrmvKRw6jom0yKVc4h': 100, // Pro
};

// Permanent tier derived from purchase — highest ever bought wins
const TIER_MAP = {
  'price_1TXaqMHrmvKRw6joRElli2MC': 'standard',  // Starter
  'price_1TXaqNHrmvKRw6joLn6joNdC': 'creator',   // Creator
  'price_1TXaqNHrmvKRw6jom0yKVc4h': 'pro',        // Pro
};

const TIER_RANK = { standard: 0, creator: 1, pro: 2 };

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

    // ── VERIFY PAYMENT + ADD CREDITS + STAMP TIER ─────────
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

      // ── DUPLICATE PAYMENT PREVENTION ──────────────────
      const { data: existingPayment } = await supabase
        .from('payments')
        .select('id, credits_added')
        .eq('stripe_session_id', sessionId)
        .single();

      if (existingPayment) {
        const { data: profile } = await supabase
          .from('profiles').select('credits, model_tier').eq('id', uid).single();
        return res.status(200).json({
          success: true,
          credits: profile?.credits || 0,
          tier: profile?.model_tier || 'standard',
          added: 0,
          duplicate: true
        });
      }

      const { data: profile, error: fetchErr } = await supabase
        .from('profiles').select('credits, model_tier').eq('id', uid).single();
      if (fetchErr) return res.status(500).json({ error: fetchErr.message });

      const newCredits = (profile.credits || 0) + creditsToAdd;

      // Stamp tier — permanent, highest ever bought wins
      const newTier = TIER_MAP[pid] || 'standard';
      const currentTierRank = TIER_RANK[profile?.model_tier] ?? 0;
      const newTierRank = TIER_RANK[newTier] ?? 0;
      const tierToSet = newTierRank > currentTierRank ? newTier : (profile?.model_tier || 'standard');

      const { error: updateErr } = await supabase
        .from('profiles').update({ credits: newCredits, model_tier: tierToSet }).eq('id', uid);
      if (updateErr) return res.status(500).json({ error: updateErr.message });

      // Record payment so it can't be replayed
      await supabase.from('payments').insert({
        user_id: uid,
        stripe_session_id: sessionId,
        price_id: pid,
        credits_added: creditsToAdd,
        amount_total: session.amount_total,
        currency: session.currency,
      });

      return res.status(200).json({ success: true, credits: newCredits, added: creditsToAdd, tier: tierToSet });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Stripe handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}

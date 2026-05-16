import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.Stripe_secret_key);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CREDIT_PACKS = {
  'price_1TXWyIHdibGBYkOdq8xDgdql': 10,  // Starter $9
  'price_1TXX05HdibGBYkOdW5a0H0mN': 30,  // Creator $25
  'price_1TXX0wHdibGBYkOddBgIC5oT': 100, // Pro $69
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, priceId, userId, userEmail } = req.body;

  // ── CREATE CHECKOUT SESSION ──────────────────────────────
  if (action === 'create_checkout') {
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'payment',
        success_url: `https://alter-ego.photography/app/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `https://alter-ego.photography/app/?payment=cancelled`,
        customer_email: userEmail,
        metadata: { userId, priceId },
      });
      return res.status(200).json({ url: session.url });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── VERIFY PAYMENT + ADD CREDITS ─────────────────────────
  if (action === 'verify_payment') {
    try {
      const session = await stripe.checkout.sessions.retrieve(req.body.sessionId);

      if (session.payment_status !== 'paid') {
        return res.status(400).json({ error: 'Payment not completed' });
      }

      const { userId: uid, priceId: pid } = session.metadata;
      const creditsToAdd = CREDIT_PACKS[pid];

      if (!creditsToAdd) {
        return res.status(400).json({ error: 'Unknown price ID' });
      }

      // Fetch current credits
      const { data: profile, error: fetchError } = await supabase
        .from('profiles')
        .select('credits')
        .eq('id', uid)
        .single();

      if (fetchError) return res.status(500).json({ error: fetchError.message });

      const newCredits = (profile.credits || 0) + creditsToAdd;

      // Update credits
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ credits: newCredits })
        .eq('id', uid);

      if (updateError) return res.status(500).json({ error: updateError.message });

      return res.status(200).json({ success: true, credits: newCredits, added: creditsToAdd });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}

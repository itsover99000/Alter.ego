// lib/stripe-grant.js
// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for turning a paid Stripe Checkout Session into
// credits + tier. Called by BOTH:
//   • /api/stripe  (action: verify_payment)  — the user landed back on success
//   • /api/stripe-webhook (checkout.session.completed) — fires even if the user
//     closed the tab mid-redirect, so a paid purchase is never lost.
//
// IDEMPOTENCY: the `payments` table has stripe_session_id as the key. We insert
// the payment row FIRST and only grant credits if that insert wins. A UNIQUE
// constraint on stripe_session_id (see DEPLOY_v133.sql) means that if both the
// webhook and verify_payment race, exactly one insert succeeds and credits are
// granted exactly once. The loser detects the existing row and returns the
// current balance without granting again.
// ─────────────────────────────────────────────────────────────────────────────

export const CREDIT_PACKS = {
  'price_1TXaqMHrmvKRw6joRElli2MC': 10,  // Starter
  'price_1TXaqNHrmvKRw6joLn6joNdC': 30,  // Creator
  'price_1TXaqNHrmvKRw6jom0yKVc4h': 100, // Pro
};

export const TIER_MAP = {
  'price_1TXaqMHrmvKRw6joRElli2MC': 'standard',
  'price_1TXaqNHrmvKRw6joLn6joNdC': 'creator',
  'price_1TXaqNHrmvKRw6jom0yKVc4h': 'pro',
};

const TIER_RANK = { standard: 0, creator: 1, pro: 2 };

// session: a Stripe Checkout Session object (must include id, metadata.userId,
//          metadata.priceId, payment_status, amount_total, currency).
// Returns { success, credits, tier, added, duplicate }.
// Throws on hard DB errors; callers map that to a 500.
export async function grantCreditsForSession(supabase, session) {
  const sessionId = session.id;
  const uid = session.metadata?.userId;
  const pid = session.metadata?.priceId;
  const creditsToAdd = CREDIT_PACKS[pid];

  if (session.payment_status !== 'paid') {
    return { success: false, error: 'Payment not completed' };
  }
  if (!creditsToAdd || !uid) {
    return { success: false, error: 'Invalid session metadata' };
  }

  // ── ATTEMPT TO CLAIM THIS SESSION (the lock) ───────────────────────────────
  // Insert the payment row first. If stripe_session_id already exists, the
  // UNIQUE constraint rejects this insert and we know credits were already
  // granted — so we return the current balance without granting again.
  const { error: insertErr } = await supabase.from('payments').insert({
    user_id: uid,
    stripe_session_id: sessionId,
    price_id: pid,
    credits_added: creditsToAdd,
    amount_total: session.amount_total,
    currency: session.currency,
  });

  if (insertErr) {
    // 23505 = unique_violation → already processed by the other path.
    const isDuplicate =
      insertErr.code === '23505' ||
      /duplicate key|unique/i.test(insertErr.message || '');
    if (isDuplicate) {
      const { data: profile } = await supabase
        .from('profiles').select('credits, model_tier').eq('id', uid).single();
      return {
        success: true,
        credits: profile?.credits || 0,
        tier: profile?.model_tier || 'standard',
        added: 0,
        duplicate: true,
      };
    }
    // A real DB error — surface it.
    throw new Error(insertErr.message);
  }

  // ── WE WON THE CLAIM → GRANT CREDITS + STAMP TIER ──────────────────────────
  const { data: profile, error: fetchErr } = await supabase
    .from('profiles').select('credits, model_tier').eq('id', uid).single();
  if (fetchErr) throw new Error(fetchErr.message);

  const newCredits = (profile?.credits || 0) + creditsToAdd;

  // Tier is permanent — the highest ever bought wins.
  const newTier = TIER_MAP[pid] || 'standard';
  const currentTierRank = TIER_RANK[profile?.model_tier] ?? 0;
  const newTierRank = TIER_RANK[newTier] ?? 0;
  const tierToSet = newTierRank > currentTierRank
    ? newTier
    : (profile?.model_tier || 'standard');

  const { error: updateErr } = await supabase
    .from('profiles').update({ credits: newCredits, model_tier: tierToSet }).eq('id', uid);
  if (updateErr) throw new Error(updateErr.message);

  return { success: true, credits: newCredits, added: creditsToAdd, tier: tierToSet };
}

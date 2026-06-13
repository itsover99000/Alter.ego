// lib/animate-credits.js
// ─────────────────────────────────────────────────────────────────────────────
// Animation credit cost + refund logic, shared by /api/animate (submission) and
// /api/animate-poll (polling/timeout). Up-front deduction happens in animate.js
// via the atomic deduct_credits_if_available RPC; this module handles giving the
// credits BACK exactly once when a job fails or times out.
//
// REPLAY PROTECTION: refunds are bound to a row in the animate_jobs table keyed
// by request_id (UNIQUE). refundJobOnce() atomically flips refunded=false→true
// and only credits the user on the flip that wins, so a determined authed user
// replaying a genuinely-failed request_id can never be refunded twice.
// ─────────────────────────────────────────────────────────────────────────────

export const ANIMATE_CREDIT_COST = 8; // ~$0.56 for 5s Kling v3 Pro

// Plain credit-back, no job binding. Used by animate.js for submission failures
// that happen BEFORE any pollable job (and thus any request_id) exists, so there
// is nothing for the client to replay.
export async function creditBack(supabase, userId) {
  if (!userId) return;
  const { data: profile } = await supabase
    .from('profiles').select('credits').eq('id', userId).single();
  if (profile) {
    await supabase.from('profiles')
      .update({ credits: (profile.credits || 0) + ANIMATE_CREDIT_COST })
      .eq('id', userId);
  }
}

// Record a freshly-submitted async job so its eventual refund can be guarded.
export async function recordAnimateJob(supabase, userId, requestId) {
  if (!requestId || !userId) return;
  // Ignore conflicts — if it somehow already exists, the existing row governs.
  await supabase.from('animate_jobs')
    .insert({ request_id: requestId, user_id: userId, refunded: false })
    .then(() => {}, () => {});
}

// Refund exactly once for a given request_id owned by userId. Returns true if
// THIS call performed the refund, false if it was already refunded / not owned.
export async function refundJobOnce(supabase, userId, requestId) {
  if (!userId || !requestId) return false;

  // 1. Try to claim an existing un-refunded job owned by this user.
  const { data: claimed } = await supabase
    .from('animate_jobs')
    .update({ refunded: true })
    .eq('request_id', requestId)
    .eq('user_id', userId)
    .eq('refunded', false)
    .select('request_id');

  if (claimed && claimed.length > 0) {
    await creditBack(supabase, userId);
    return true;
  }

  // 2. A row exists but wasn't claimable → already refunded or different owner.
  const { data: existing } = await supabase
    .from('animate_jobs')
    .select('request_id')
    .eq('request_id', requestId)
    .limit(1);
  if (existing && existing.length > 0) return false;

  // 3. No row at all (e.g. a job submitted by a pre-v133 client during deploy
  //    overlap). Insert it as already-refunded to claim the one-time refund; the
  //    UNIQUE constraint on request_id guards against a concurrent race.
  const { error: insErr } = await supabase
    .from('animate_jobs')
    .insert({ request_id: requestId, user_id: userId, refunded: true });
  if (insErr) return false; // lost the race — someone else claimed it

  await creditBack(supabase, userId);
  return true;
}

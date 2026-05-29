import { createClient } from '@supabase/supabase-js';

// ── muapi polling ────────────────────────────────────────────────────────────
// muapi returns an async job ID. We poll until status = 'completed' or timeout.
async function pollMuapi(jobId, muapiKey, maxAttempts = 30, intervalMs = 2000) {
  const pollUrl = `https://muapi.ai/api/v1/predictions/${jobId}`;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    const pollRes = await fetch(pollUrl, {
      headers: { 'x-api-key': muapiKey }
    });
    const data = await pollRes.json();
    console.log(`muapi poll ${i + 1}:`, data.status);
    if (data.status === 'completed' || data.status === 'succeeded') {
      // Try multiple output shapes muapi uses
      const url = data.output?.image_url
        || data.output?.outputs?.[0]
        || data.outputs?.[0]
        || data.output?.urls?.get;
      if (url) return url;
    }
    if (data.status === 'failed' || data.status === 'error') {
      throw new Error(`muapi job failed: ${data.error || 'unknown error'}`);
    }
  }
  throw new Error('muapi generation timed out');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { userId, imageUrl, style, prompt, selectedModel } = req.body;
  if (!userId || !imageUrl) return res.status(400).json({ error: 'Missing fields' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // ── Fetch user profile ───────────────────────────────────────────────────
  const { data: profile } = await supabase
    .from('profiles')
    .select('credits, total_generations, model_tier, unlocked_models')
    .eq('id', userId)
    .single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  // ── Resolve model ────────────────────────────────────────────────────────
  const modelKey = selectedModel || 'flux-pulid';

  // Fetch model record
  const { data: modelRecord } = await supabase
    .from('models')
    .select('*')
    .eq('key', modelKey)
    .eq('active', true)
    .single();

  if (!modelRecord) return res.status(400).json({ error: 'Unknown model' });

  // ── Entitlement check ────────────────────────────────────────────────────
  const tier = profile.model_tier || 'standard';
  const unlocked = profile.unlocked_models || [];
  const isEntitled =
    modelKey === 'flux-pulid' ||
    tier === 'premium' ||
    unlocked.includes(modelKey);

  if (!isEntitled) {
    return res.status(403).json({ error: 'You are not entitled to use this model. Unlock it with an access code or upgrade to Pro.' });
  }

  // ── Credit check ─────────────────────────────────────────────────────────
  const creditCost = modelRecord.credit_cost || 1;
  if (profile.credits < creditCost) {
    return res.status(402).json({
      error: `Not enough credits. This model costs ${creditCost} credit${creditCost > 1 ? 's' : ''}. You have ${profile.credits}.`
    });
  }

  // ── Deduct credits + save generation ────────────────────────────────────
  await supabase.from('profiles').update({
    credits: profile.credits - creditCost,
    total_generations: (profile.total_generations || 0) + 1
  }).eq('id', userId);

  await supabase.from('generations').insert({
    user_id: userId,
    image_url: imageUrl,
    style: style || '',
    prompt: prompt || '',
    model: modelKey
  });

  return res.status(200).json({
    credits: profile.credits - creditCost,
    model: modelKey,
    credit_cost: creditCost
  });
}

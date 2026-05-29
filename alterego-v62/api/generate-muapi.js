import { createClient } from '@supabase/supabase-js';

// muapi model slug mapping — key = our internal key, value = muapi's endpoint slug
const MUAPI_MODEL_SLUGS = {
  'midjourney-v8':        'midjourney-v8',
  'nano-banana-pro':      'nano-banana-pro',
  'google-imagen4-ultra': 'google-imagen4-ultra',
  'gpt4o-text-to-image':  'gpt4o-text-to-image',
};

// Poll muapi for job completion
async function pollMuapi(jobId, muapiKey, maxAttempts = 30, intervalMs = 2000) {
  const pollUrl = `https://api.muapi.ai/api/v1/predictions/${jobId}`;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    const pollRes = await fetch(pollUrl, {
      headers: { 'x-api-key': muapiKey }
    });
    const data = await pollRes.json();
    console.log(`muapi poll ${i + 1}: status=${data.status}`);

    if (data.status === 'completed' || data.status === 'succeeded') {
      const url = data.output?.image_url
        || data.output?.outputs?.[0]
        || data.outputs?.[0]
        || data.output?.urls?.get;
      if (url) return { url };
      console.log('muapi completed but no image URL found:', JSON.stringify(data).slice(0, 400));
      throw new Error('Generation completed but no image URL returned');
    }
    if (data.status === 'failed' || data.status === 'error') {
      throw new Error(`muapi generation failed: ${data.error || 'unknown error'}`);
    }
  }
  throw new Error('muapi generation timed out after 60 seconds');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const muapiKey = process.env.MUAPI_API_KEY;
  if (!muapiKey) return res.status(500).json({ error: 'MUAPI_API_KEY not configured' });

  const { prompt, modelKey, userId } = req.body;
  if (!prompt || !modelKey || !userId) {
    return res.status(400).json({ error: 'Missing prompt, modelKey, or userId' });
  }

  // ── Credit pre-check ─────────────────────────────────────────────────────
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data: profile } = await supabase
    .from('profiles').select('credits').eq('id', userId).single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const { data: modelRecord } = await supabase
    .from('models').select('credit_cost').eq('key', modelKey).single();

  const creditCost = modelRecord?.credit_cost || 2;
  if (profile.credits < creditCost) {
    return res.status(402).json({
      error: { message: `Not enough credits. This model costs ${creditCost} credits. You have ${profile.credits}.` }
    });
  }

  // ── Resolve muapi slug ───────────────────────────────────────────────────
  const slug = MUAPI_MODEL_SLUGS[modelKey];
  if (!slug) return res.status(400).json({ error: `No muapi slug for model: ${modelKey}` });

  const endpoint = `https://api.muapi.ai/api/v1/${slug}`;
  console.log(`muapi generate: model=${slug}, endpoint=${endpoint}`);

  try {
    // ── Submit job ─────────────────────────────────────────────────────────
    const submitRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': muapiKey
      },
      body: JSON.stringify({
        prompt,
        aspect_ratio: '3:4',
        negative_prompt: 'ugly, deformed, blurry, low quality, watermark, text'
      })
    });

    const submitData = await submitRes.json();
    console.log('muapi submit response:', JSON.stringify(submitData).slice(0, 300));

    if (!submitRes.ok) {
      return res.status(500).json({
        error: { message: submitData.detail || submitData.error || 'muapi submission failed' }
      });
    }

    // ── Check if synchronous or async ─────────────────────────────────────
    // Some muapi models return immediately, others return a job ID
    if (submitData.output?.image_url || submitData.outputs?.[0]) {
      const imageUrl = submitData.output?.image_url || submitData.outputs[0];
      return res.status(200).json({ images: [{ url: imageUrl }] });
    }

    // Async — poll for result
    const jobId = submitData.id || submitData.request_id;
    if (!jobId) {
      console.log('muapi no job ID in response:', JSON.stringify(submitData));
      return res.status(500).json({ error: { message: 'muapi did not return a job ID' } });
    }

    const { url } = await pollMuapi(jobId, muapiKey);
    return res.status(200).json({ images: [{ url }] });

  } catch (err) {
    console.log('muapi error:', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
}

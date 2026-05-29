import { createClient } from '@supabase/supabase-js';

// muapi model slug mapping
const MUAPI_MODEL_SLUGS = {
  'midjourney-v8':        'midjourney-v8',
  'nano-banana-pro':      'nano-banana-pro',
  'google-imagen4-ultra': 'google-imagen4-ultra',
  'gpt4o-text-to-image':  'gpt4o-text-to-image',
};

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
  console.log(`muapi generate: model=${slug}`);

  try {
    // ── Submit job — return request_id immediately, client polls ─────────
    const submitRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': muapiKey
      },
      // GPT-4o only supports 1:1, 2:3, 3:2 — others support 3:4
      const aspectRatio = (slug === 'gpt4o-text-to-image') ? '2:3' : '3:4';
      body: JSON.stringify({
        prompt,
        aspect_ratio: aspectRatio,
        negative_prompt: 'ugly, deformed, blurry, low quality, watermark, text'
      })
    });

    const submitData = await submitRes.json();
    console.log('muapi submit:', JSON.stringify(submitData).slice(0, 200));

    if (!submitRes.ok) {
      const errDetail = Array.isArray(submitData.detail) 
        ? submitData.detail.map(e => e.msg || e.message || JSON.stringify(e)).join(', ')
        : submitData.detail || submitData.error || 'muapi submission failed';
      return res.status(500).json({ error: { message: errDetail } });
    }

    // If completed immediately (unlikely but handle it)
    if (submitData.status === 'completed' && submitData.outputs?.[0]) {
      return res.status(200).json({ images: [{ url: submitData.outputs[0] }] });
    }

    // Return job ID for client-side polling
    const jobId = submitData.request_id || submitData.id;
    if (!jobId) {
      return res.status(500).json({ error: { message: 'muapi did not return a job ID' } });
    }

    return res.status(202).json({ jobId, status: 'processing' });

  } catch (err) {
    console.log('muapi error:', err.message);
    return res.status(500).json({ error: { message: err.message } });
  }
}

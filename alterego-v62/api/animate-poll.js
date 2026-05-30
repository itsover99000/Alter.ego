import { createClient } from '@supabase/supabase-js';

const ANIMATE_CREDIT_COST = 8;

async function refundCredits(userId) {
  if (!userId) return;
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: profile } = await supabase.from('profiles').select('credits').eq('id', userId).single();
    if (profile) {
      await supabase.from('profiles')
        .update({ credits: profile.credits + ANIMATE_CREDIT_COST })
        .eq('id', userId);
      console.log(`animate-poll: refunded ${ANIMATE_CREDIT_COST} credits to ${userId}`);
    }
  } catch (e) {
    console.log('animate-poll refund error:', e.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  const { requestId, userId, refundOnly } = req.body;
  if (!requestId) return res.status(400).json({ error: 'Missing requestId' });

  // Client-side timeout refund
  if (refundOnly) {
    await refundCredits(userId);
    return res.status(200).json({ refunded: true });
  }

  try {
    const pollRes = await fetch(
      `https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video/requests/${requestId}`,
      { headers: { 'Authorization': `Key ${falKey}` } }
    );

    const data = await pollRes.json();
    console.log(`animate-poll: status=${data.status}, requestId=${requestId}`);

    if (data.status === 'COMPLETED') {
      // Fetch the actual result
      const resultRes = await fetch(
        `https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video/requests/${requestId}/response`,
        { headers: { 'Authorization': `Key ${falKey}` } }
      );
      const result = await resultRes.json();
      const videoUrl = result.video?.url;
      if (videoUrl) return res.status(200).json({ status: 'completed', videoUrl });
      return res.status(500).json({ error: 'Completed but no video URL' });
    }

    if (data.status === 'FAILED') {
      await refundCredits(userId);
      return res.status(500).json({ error: data.error || 'Animation failed', refunded: true });
    }

    return res.status(200).json({ status: data.status || 'IN_QUEUE' });

  } catch (err) {
    console.log('animate-poll error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

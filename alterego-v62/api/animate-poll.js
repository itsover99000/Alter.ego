import { createClient } from '@supabase/supabase-js';
import { applyCors, requireUser } from '../lib/auth.js';
import { refundJobOnce } from '../lib/animate-credits.js';

const KLING_BASE = 'https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video';

// Ask fal what state a job is actually in. Used to validate client-asserted
// refunds so the client can't simply claim a timeout to mint credits.
async function falStatus(falKey, requestId) {
  const r = await fetch(`${KLING_BASE}/requests/${requestId}`, {
    headers: { 'Authorization': `Key ${falKey}` }
  });
  const d = await r.json().catch(() => ({}));
  return d.status; // COMPLETED | FAILED | IN_QUEUE | IN_PROGRESS | undefined
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── AUTH ── refunds can now only ever credit the signed-in caller, never an
  // arbitrary userId from the body.
  const auth = await requireUser(req, res);
  if (!auth) return;
  const userId = auth.userId;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const falKey = process.env.FAL_API_KEY;
  const { requestId, refundOnly } = req.body;
  if (!requestId) return res.status(400).json({ error: 'Missing requestId' });

  // ── Client-asserted timeout refund — VALIDATED against fal, refunded ONCE ──
  // Two guards: (1) we only refund if fal confirms the job is FAILED or unknown
  // (not still running / completed); (2) refundJobOnce binds the refund to the
  // animate_jobs row for this request_id and flips it once, so the same failed
  // request_id can't be replayed for repeat credits.
  if (refundOnly) {
    const status = await falStatus(falKey, requestId);
    if (status === 'FAILED' || status === undefined) {
      const did = await refundJobOnce(supabase, userId, requestId);
      return res.status(200).json({ refunded: did });
    }
    return res.status(200).json({ refunded: false, status: status || 'unknown' });
  }

  try {
    const pollRes = await fetch(`${KLING_BASE}/requests/${requestId}`,
      { headers: { 'Authorization': `Key ${falKey}` } }
    );

    const data = await pollRes.json();
    console.log(`animate-poll: status=${data.status}, requestId=${requestId}`);

    if (data.status === 'COMPLETED') {
      const resultRes = await fetch(`${KLING_BASE}/requests/${requestId}/response`,
        { headers: { 'Authorization': `Key ${falKey}` } }
      );
      const result = await resultRes.json();
      const videoUrl = result.video?.url;
      if (videoUrl) return res.status(200).json({ status: 'completed', videoUrl });
      return res.status(500).json({ error: 'Completed but no video URL' });
    }

    if (data.status === 'FAILED') {
      const did = await refundJobOnce(supabase, userId, requestId);
      return res.status(500).json({ error: data.error || 'Animation failed', refunded: did });
    }

    return res.status(200).json({ status: data.status || 'IN_QUEUE' });

  } catch (err) {
    console.log('animate-poll error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

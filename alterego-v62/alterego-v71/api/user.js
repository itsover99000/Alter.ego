import { applyCors, requireUser } from '../lib/auth.js';

// ── /api/user ────────────────────────────────────────────────────────────────
// Merged endpoint that replaces the old /api/profile and /api/generations.
// Merging two functions into one frees a Vercel Hobby function slot (12-ceiling)
// for /api/stripe-webhook. Behaviour is identical; the client picks which read
// it wants via the `action` field:
//   action: 'profile'      → { credits, total_generations }
//   action: 'generations'  → { generations: [...] }   (latest 12)
//
// As with every endpoint since v133, the user id comes from the verified JWT,
// never the request body.

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireUser(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;

  const { action } = req.body || {};

  if (action === 'profile') {
    const { data, error } = await supabase
      .from('profiles')
      .select('credits, total_generations')
      .eq('id', userId)
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (action === 'generations') {
    const { data, error } = await supabase
      .from('generations')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(12);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ generations: data || [] });
  }

  return res.status(400).json({ error: 'Unknown action' });
}

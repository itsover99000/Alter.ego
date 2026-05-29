import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Get user profile to check tier and unlocked models
  const { data: profile } = await supabase
    .from('profiles')
    .select('model_tier, unlocked_models')
    .eq('id', userId)
    .single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const tier = profile.model_tier || 'standard';
  const unlocked = profile.unlocked_models || [];

  // Get all active models
  const { data: models } = await supabase
    .from('models')
    .select('*')
    .eq('active', true)
    .order('credit_cost', { ascending: true });

  if (!models) return res.status(500).json({ error: 'Could not fetch models' });

  // Filter to models the user is entitled to
  const entitled = models.filter(m => {
    if (m.key === 'flux-pulid') return true;           // default always available
    if (tier === 'premium') return true;                // pro tier gets everything
    if (unlocked.includes(m.key)) return true;         // access code unlocked
    return false;
  });

  return res.status(200).json({ models: entitled, tier, unlocked });
}

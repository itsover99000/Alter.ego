import { createClient } from '@supabase/supabase-js';

// Theme tier requirements — hardcoded, no new table needed
const THEME_TIERS = {
  'pets':      'creator',
  'st-moritz': 'creator',
  'samurai':   'creator',
  'cyborg':    'creator',
  'old-money': 'creator',
  'dark-academia': 'creator',
  'western':   'creator',
};

const TIER_RANK = { standard: 0, creator: 1, pro: 2 };

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

  const { data: profile } = await supabase
    .from('profiles')
    .select('model_tier, unlocked_models')
    .eq('id', userId)
    .single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const tier = profile.model_tier || 'standard';
  const unlocked = profile.unlocked_models || [];
  const userTierRank = TIER_RANK[tier] ?? 0;

  // Get all active models
  const { data: models } = await supabase
    .from('models')
    .select('*')
    .eq('active', true)
    .order('credit_cost', { ascending: true });

  if (!models) return res.status(500).json({ error: 'Could not fetch models' });

  // Filter to models the user is entitled to.
  // Override is per-model: only the exact model keys in unlocked_models bypass tier.
  const entitled = models.filter(m => {
    if (m.key === 'flux-pulid') return true;
    if (unlocked.includes(m.key)) return true;
    const required = TIER_RANK[m.tier_required] ?? 1;
    return userTierRank >= required;
  });

  // Build locked themes list for UI — themes visible but not selectable.
  // Override is per-theme: a theme is only unlocked-by-code if its exact key
  // is in unlocked_models, never "the user unlocked something else".
  const lockedThemes = Object.entries(THEME_TIERS)
    .filter(([theme, requiredTier]) => {
      const required = TIER_RANK[requiredTier] ?? 1;
      const unlockedByCode = unlocked.includes(theme);
      return userTierRank < required && !unlockedByCode;
    })
    .map(([theme]) => theme);

  // Unlocked themes — accessible to this user
  const unlockedThemes = Object.keys(THEME_TIERS).filter(t => !lockedThemes.includes(t));

  return res.status(200).json({
    models: entitled,
    tier,
    unlocked,
    lockedThemes,   // client renders these with lock icon
    unlockedThemes, // client allows these to be selected
  });
}

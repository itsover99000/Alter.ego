import { applyCors, requireUser } from '../lib/auth.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // The code gets redeemed onto the SIGNED-IN user, taken from the JWT — so a
  // caller can't redeem a limited-use code onto an arbitrary account.
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { userId, supabase } = auth;

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  // Look up the access code
  const { data: accessCode } = await supabase
    .from('access_codes')
    .select('*')
    .eq('code', code.trim().toUpperCase())
    .single();

  if (!accessCode) return res.status(404).json({ error: 'Invalid access code' });

  // Check expiry
  if (accessCode.expires_at && new Date(accessCode.expires_at) < new Date()) {
    return res.status(400).json({ error: 'This access code has expired' });
  }

  // Check max uses
  if (accessCode.max_uses !== null && accessCode.use_count >= accessCode.max_uses) {
    return res.status(400).json({ error: 'This access code has reached its maximum uses' });
  }

  // Get user's current unlocked models
  const { data: profile } = await supabase
    .from('profiles')
    .select('unlocked_models')
    .eq('id', userId)
    .single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  // Merge new unlocked models with existing ones (no duplicates)
  const existing = profile.unlocked_models || [];
  const merged = [...new Set([...existing, ...accessCode.unlocks])];

  // Update profile with merged unlocked models
  await supabase
    .from('profiles')
    .update({ unlocked_models: merged })
    .eq('id', userId);

  // Increment use count on access code
  await supabase
    .from('access_codes')
    .update({ use_count: accessCode.use_count + 1 })
    .eq('id', accessCode.id);

  // Return the newly unlocked model keys
  const newlyUnlocked = accessCode.unlocks.filter(k => !existing.includes(k));

  return res.status(200).json({
    success: true,
    unlocked: merged,
    newly_unlocked: newlyUnlocked,
    message: newlyUnlocked.length > 0
      ? `Unlocked: ${newlyUnlocked.join(', ')}`
      : 'Models already unlocked'
  });
}

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { userId, imageUrl, style, prompt } = req.body;
  if (!userId || !imageUrl) return res.status(400).json({ error: 'Missing fields' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data: profile } = await supabase
    .from('profiles').select('credits, total_generations').eq('id', userId).single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  if (profile.credits <= 0) return res.status(402).json({ error: 'No credits' });

  await supabase.from('profiles').update({
    credits: profile.credits - 1,
    total_generations: (profile.total_generations || 0) + 1
  }).eq('id', userId);

  await supabase.from('generations').insert({
    user_id: userId,
    image_url: imageUrl,
    style: style || '',
    prompt: prompt || ''
  });

  return res.status(200).json({ credits: profile.credits - 1 });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  const { requestId } = req.body;
  if (!requestId) return res.status(400).json({ error: 'Missing requestId' });

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
      return res.status(500).json({ error: data.error || 'Animation failed' });
    }

    return res.status(200).json({ status: data.status || 'IN_QUEUE' });

  } catch (err) {
    console.log('animate-poll error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

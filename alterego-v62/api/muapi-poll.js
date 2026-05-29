export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const muapiKey = process.env.MUAPI_API_KEY;
  if (!muapiKey) return res.status(500).json({ error: 'MUAPI_API_KEY not configured' });

  const { jobId } = req.body;
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

  try {
    const pollUrl = `https://api.muapi.ai/api/v1/predictions/${jobId}/result`;
    const pollRes = await fetch(pollUrl, {
      headers: { 'x-api-key': muapiKey }
    });

    const data = await pollRes.json();
    console.log(`muapi-poll: status=${data.status}, jobId=${jobId}`);

    if (data.status === 'completed') {
      const url = data.outputs?.[0] || data.output?.image_url;
      if (url) return res.status(200).json({ status: 'completed', url });
      return res.status(500).json({ error: 'Completed but no image URL' });
    }

    if (data.status === 'failed') {
      return res.status(500).json({ error: data.error || 'Generation failed' });
    }

    // Still processing
    return res.status(200).json({ status: data.status || 'processing' });

  } catch (err) {
    console.log('muapi-poll error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

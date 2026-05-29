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

    const rawText = await pollRes.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      console.log('muapi-poll non-JSON response:', pollRes.status, rawText.slice(0, 200));
      // If still getting HTML, keep polling — muapi may not have the result yet
      return res.status(200).json({ status: 'processing' });
    }
    // Status can be at root or nested inside 'detail'
    const result = data.detail || data;
    const status = result.status;
    console.log(`muapi-poll: status=${status}, jobId=${jobId}`);

    // Check for output URL regardless of status — muapi sometimes marks
    // jobs as 'failed' even when they produced a valid output image
    const url = result.outputs?.[0] || result.output?.image_url;
    if (url) return res.status(200).json({ status: 'completed', url });

    if (status === 'completed') {
      return res.status(500).json({ error: 'Completed but no image URL returned' });
    }

    if (status === 'failed') {
      return res.status(500).json({ error: result.error || 'Generation failed on muapi' });
    }

    // Still processing
    return res.status(200).json({ status: status || 'processing' });

  } catch (err) {
    console.log('muapi-poll error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

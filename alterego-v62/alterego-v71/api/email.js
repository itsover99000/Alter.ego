// /api/email.js
// Unified transactional email sender via Resend
// Handles: welcome, purchase_confirmation, password_reset
//
// v133 hardening: previously this accepted any { type, to } and sent our
// branded email to any address — an open relay that could be scripted to spam
// or phish using our verified domain's reputation. It now (1) requires a
// signed-in user and (2) only ever sends to that user's OWN verified email,
// ignoring any `to` the client supplies. The welcome email therefore moved
// from right-after-signUp (no session yet) to first sign-in (see app onSignedIn).

import { applyCors, requireUser } from '../lib/auth.js';

const ALLOWED_TYPES = new Set(['welcome', 'purchase_confirmation', 'password_reset']);

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Must be signed in. The recipient is forced to the caller's own verified
  // address — the body's `to` is no longer trusted.
  const auth = await requireUser(req, res);
  if (!auth) return;
  const to = auth.user.email;

  const { type, data } = req.body;

  if (!type || !ALLOWED_TYPES.has(type)) {
    return res.status(400).json({ error: 'Unknown email type' });
  }
  if (!to) {
    return res.status(400).json({ error: 'No verified email on account' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    return res.status(500).json({ error: 'Resend API key not configured' });
  }

  let subject, html;

  // ── EMAIL TEMPLATES ──────────────────────────────────────

  if (type === 'welcome') {
    subject = 'Welcome to ALTER.EGO — your first life is free';
    html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome to ALTER.EGO</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo -->
          <tr>
            <td style="padding-bottom:32px;">
              <span style="font-size:22px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#f5f3ee;">ALTER<span style="color:#c8f05a;">.</span>EGO</span>
            </td>
          </tr>

          <!-- Hero image strip -->
          <tr>
            <td style="padding-bottom:32px;">
              <div style="background:linear-gradient(135deg,#1a1a1a 0%,#2a2a2a 100%);height:4px;width:100%;"></div>
            </td>
          </tr>

          <!-- Headline -->
          <tr>
            <td style="padding-bottom:16px;">
              <h1 style="margin:0;font-size:36px;font-weight:900;line-height:1.05;color:#f5f3ee;font-family:Georgia,serif;">
                Welcome.<br>
                <em style="color:#c8f05a;font-style:italic;">You just unlocked</em><br>
                infinite lives.
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding-bottom:32px;">
              <p style="margin:0;font-size:14px;line-height:1.8;color:rgba(245,243,238,0.6);letter-spacing:0.02em;">
                Your ALTER.EGO account is ready. You have <strong style="color:#c8f05a;">1 free credit</strong> waiting — enough to step into your first world.
              </p>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding-bottom:40px;">
              <a href="https://alter-ego.photography/app/" style="display:inline-block;background:#c8f05a;color:#0a0a0a;text-decoration:none;padding:16px 36px;font-size:12px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;">
                Create your first alter ego →
              </a>
            </td>
          </tr>

          <!-- Styles grid hint -->
          <tr>
            <td style="padding-bottom:40px;border-top:0.5px solid rgba(245,243,238,0.08);padding-top:32px;">
              <p style="margin:0 0 16px;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:rgba(245,243,238,0.3);">16 worlds to explore</p>
              <p style="margin:0;font-size:13px;line-height:1.7;color:rgba(245,243,238,0.5);">
                Cinematic · Cyberpunk · Acotar · Riviera · Sovereign · Fashion · Warhol · Anime · Painterly · Glamour · Sci-Fi · Streetwear · Athlete · Headshot · Campaign · Bohemian
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:0.5px solid rgba(245,243,238,0.08);padding-top:24px;">
              <p style="margin:0;font-size:10px;letter-spacing:0.06em;color:rgba(245,243,238,0.2);text-transform:uppercase;">
                © 2026 ALTER.EGO · alter-ego.photography<br>
                Operated by Inhaus Media · Sydney, Australia<br><br>
                <a href="https://alter-ego.photography/privacy" style="color:rgba(245,243,238,0.2);text-decoration:none;">Privacy Policy</a> &nbsp;·&nbsp;
                <a href="https://alter-ego.photography/terms" style="color:rgba(245,243,238,0.2);text-decoration:none;">Terms of Use</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  else if (type === 'purchase_confirmation') {
    const { credits, pack, amount } = data || {};
    subject = `Your ${pack || ''} credits are ready — ALTER.EGO`;
    html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo -->
          <tr>
            <td style="padding-bottom:32px;">
              <span style="font-size:22px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#f5f3ee;">ALTER<span style="color:#c8f05a;">.</span>EGO</span>
            </td>
          </tr>

          <!-- Headline -->
          <tr>
            <td style="padding-bottom:16px;">
              <h1 style="margin:0;font-size:36px;font-weight:900;line-height:1.05;color:#f5f3ee;font-family:Georgia,serif;">
                <em style="color:#c8f05a;font-style:italic;">${credits} credits</em><br>
                added to your account.
              </h1>
            </td>
          </tr>

          <!-- Order summary -->
          <tr>
            <td style="padding-bottom:32px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(245,243,238,0.04);border:0.5px solid rgba(245,243,238,0.08);">
                <tr>
                  <td style="padding:20px 24px;border-bottom:0.5px solid rgba(245,243,238,0.06);">
                    <span style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(245,243,238,0.3);">Order summary</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 24px;border-bottom:0.5px solid rgba(245,243,238,0.06);">
                    <table width="100%">
                      <tr>
                        <td style="font-size:13px;color:rgba(245,243,238,0.7);">${pack} Pack — ${credits} credits</td>
                        <td align="right" style="font-size:13px;color:#f5f3ee;font-weight:700;">${amount}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 24px;">
                    <span style="font-size:11px;color:rgba(245,243,238,0.4);">Credits never expire · Use anytime across all 16 styles</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding-bottom:40px;">
              <a href="https://alter-ego.photography/app/" style="display:inline-block;background:#c8f05a;color:#0a0a0a;text-decoration:none;padding:16px 36px;font-size:12px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;">
                Start generating →
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:0.5px solid rgba(245,243,238,0.08);padding-top:24px;">
              <p style="margin:0;font-size:10px;letter-spacing:0.06em;color:rgba(245,243,238,0.2);text-transform:uppercase;">
                © 2026 ALTER.EGO · alter-ego.photography<br>
                Questions? <a href="mailto:contact@inhausmedia.com.au" style="color:rgba(245,243,238,0.35);text-decoration:none;">contact@inhausmedia.com.au</a><br><br>
                <a href="https://alter-ego.photography/privacy" style="color:rgba(245,243,238,0.2);text-decoration:none;">Privacy Policy</a> &nbsp;·&nbsp;
                <a href="https://alter-ego.photography/terms" style="color:rgba(245,243,238,0.2);text-decoration:none;">Terms of Use</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  else if (type === 'password_reset') {
    const { resetLink } = data || {};
    subject = 'Reset your ALTER.EGO password';
    html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- Logo -->
          <tr>
            <td style="padding-bottom:32px;">
              <span style="font-size:22px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#f5f3ee;">ALTER<span style="color:#c8f05a;">.</span>EGO</span>
            </td>
          </tr>

          <!-- Headline -->
          <tr>
            <td style="padding-bottom:16px;">
              <h1 style="margin:0;font-size:32px;font-weight:900;line-height:1.1;color:#f5f3ee;font-family:Georgia,serif;">
                Reset your password
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding-bottom:32px;">
              <p style="margin:0;font-size:14px;line-height:1.8;color:rgba(245,243,238,0.6);">
                We received a request to reset your password. Click the button below to choose a new one. This link expires in 1 hour.
              </p>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding-bottom:24px;">
              <a href="${resetLink}" style="display:inline-block;background:#c8f05a;color:#0a0a0a;text-decoration:none;padding:16px 36px;font-size:12px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;">
                Reset password →
              </a>
            </td>
          </tr>

          <!-- Security note -->
          <tr>
            <td style="padding-bottom:40px;">
              <p style="margin:0;font-size:11px;line-height:1.7;color:rgba(245,243,238,0.3);">
                If you didn't request this, you can safely ignore this email. Your password won't change.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:0.5px solid rgba(245,243,238,0.08);padding-top:24px;">
              <p style="margin:0;font-size:10px;letter-spacing:0.06em;color:rgba(245,243,238,0.2);text-transform:uppercase;">
                © 2026 ALTER.EGO · alter-ego.photography<br>
                <a href="https://alter-ego.photography/privacy" style="color:rgba(245,243,238,0.2);text-decoration:none;">Privacy Policy</a> &nbsp;·&nbsp;
                <a href="https://alter-ego.photography/terms" style="color:rgba(245,243,238,0.2);text-decoration:none;">Terms of Use</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  else {
    return res.status(400).json({ error: `Unknown email type: ${type}` });
  }

  // ── SEND VIA RESEND ──────────────────────────────────────
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'ALTER.EGO <hello@alter-ego.photography>',
        reply_to: 'contact@inhausmedia.com.au',
        to: [to],
        subject,
        html,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Resend error:', result);
      return res.status(500).json({ error: 'Failed to send email', details: result });
    }

    return res.status(200).json({ success: true, id: result.id });

  } catch (err) {
    console.error('Email send error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

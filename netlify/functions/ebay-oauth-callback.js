// Receives the redirect back from eBay's OAuth consent screen (started by
// ebay-oauth-start.js), exchanges the one-time authorization code for a
// refresh token, and saves it to Blobs. Saving directly here - rather than
// showing the token for Nathan to copy into an env var - means the secret
// never has to pass through chat or a manual paste.
const { getOAuthStore } = require('./report-shared');

function htmlPage(title, message, ok) {
  return `<!DOCTYPE html><html><head><title>${title}</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px 20px;">
<h1 style="color:${ok ? '#059669' : '#dc2626'};">${title}</h1>
<p>${message}</p>
</body></html>`;
}

exports.handler = async function(event) {
  const params = event.queryStringParameters || {};
  const { code, error } = params;

  if (error) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: htmlPage('Not connected', `eBay returned an error: ${error}`, false) };
  }
  if (!code) {
    return { statusCode: 400, headers: { 'Content-Type': 'text/html' }, body: htmlPage('Missing code', 'No authorization code was provided by eBay.', false) };
  }

  const clientId = process.env.EBAY_PROD_APP_ID;
  const clientSecret = process.env.EBAY_PROD_CERT_ID;
  const ruName = process.env.EBAY_RUNAME;

  if (!clientId || !clientSecret || !ruName) {
    return { statusCode: 500, headers: { 'Content-Type': 'text/html' }, body: htmlPage('Server not configured', 'Missing EBAY_PROD_APP_ID, EBAY_PROD_CERT_ID or EBAY_RUNAME environment variable.', false) };
  }

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: ruName
    });

    const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      },
      body: body.toString()
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.refresh_token) {
      console.error('eBay OAuth token exchange failed:', JSON.stringify(tokenData));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html' },
        body: htmlPage('Connection failed', `eBay didn't return a refresh token: ${tokenData.error_description || tokenData.error || 'unknown error'}`, false)
      };
    }

    const store = getOAuthStore();
    await store.setJSON('ebay-refresh-token', {
      refresh_token: tokenData.refresh_token,
      obtained_at: new Date().toISOString(),
      expires_in_seconds: tokenData.refresh_token_expires_in || null
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: htmlPage('Connected!', "eBay listing views are now connected. You can close this tab - future sales emails will include per-game view counts.", true)
    };
  } catch (err) {
    console.error('eBay OAuth callback error:', err);
    return { statusCode: 500, headers: { 'Content-Type': 'text/html' }, body: htmlPage('Error', err.message, false) };
  }
};

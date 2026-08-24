// One-time setup step for the listing-views feature. Visiting this URL
// redirects to eBay's OAuth consent screen so Nathan can grant read access to
// the Analytics API (traffic report / listing views). Only needs doing once -
// ebay-oauth-callback.js stores a long-lived refresh token after he approves.
//
// Requires EBAY_RUNAME to be set first: a redirect URI identifier eBay
// generates once this site's callback URL is registered in the eBay Developer
// dashboard (Application Keys > your keyset > "eBay Redirect URL / RuName").
exports.handler = async function() {
  const clientId = process.env.EBAY_PROD_APP_ID;
  const ruName = process.env.EBAY_RUNAME;

  if (!clientId || !ruName) {
    return {
      statusCode: 500,
      body: 'Missing EBAY_PROD_APP_ID or EBAY_RUNAME environment variable - the RuName needs registering in the eBay Developer dashboard first.'
    };
  }

  const scope = 'https://api.ebay.com/oauth/api_scope/sell.analytics.readonly';
  const authorizeUrl = `https://auth.ebay.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(ruName)}&response_type=code&scope=${encodeURIComponent(scope)}`;

  return {
    statusCode: 302,
    headers: { Location: authorizeUrl }
  };
};

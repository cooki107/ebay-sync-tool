// Scheduled Netlify Function - runs automatically every day
// Sends the 8am sales report email via Resend
//
// TOMORROW'S TODO:
// 1. Sign up at resend.com (free), get an API key
// 2. Add RESEND_API_KEY as an environment variable in Netlify site settings
// 3. Replace the placeholder eBay data below with real GetOrders / GetSellerList API calls
// 4. Verify the schedule time below matches 8am UK time (accounting for BST/GMT)

const { schedule } = require('@netlify/functions');
const https = require('https');

// UK is GMT (winter) or BST (summer, UTC+1). Netlify cron runs in UTC.
// 8am UK time = 7am UTC in summer (BST), 8am UTC in winter (GMT).
// Using 7am UTC as a starting point - adjust seasonally, or build DST logic later.
const CRON_SCHEDULE = '0 7 * * *'; // Every day at 07:00 UTC

const xml2js = require('xml2js');

// Reverse mapping: eBay Item ID -> game name, used to label sold items in the email
const itemIdToGameName = {
  '128032384253': 'Animal Crossing',
  '127954148871': 'Animal Crossing - Cartridge',
  '128032385043': "Luigi's Mansion 3",
  '128032381763': 'Mario Kart 8',
  '128032384109': 'Mario Kart 8 - Cartridge',
  '127907257328': 'Pokemon Arceus',
  '127916388908': 'Pokemon Arceus - Cartridge',
  '127935957482': 'Princess Peach Showtime',
  '127992249046': 'Princess Peach Showtime - Cartridge',
  '127951567807': 'Mario 3D All Stars',
  '128013972085': 'Mario 3D All Stars - Cartridge',
  '127907346508': 'Super Mario U Deluxe',
  '127940340265': 'Super Mario Wonder',
  '128017583742': 'Super Mario Wonder - Cartridge',
  '127916232402': 'Super Mario Odyssey',
  '128032561397': 'Super Mario Odyssey - Cartridge',
  '127992258497': 'Super Mario Jamboree',
  '127923383109': 'Super Smash Bros',
  '127916387430': 'Super Smash Bros - Cartridge',
  '127967561009': 'Zelda Links Awakening',
  '127927213642': 'Zelda Links Awakening - Cartridge',
  '127925580095': 'Zelda Breath of the wild',
  '128013967400': 'Zelda Breath of the wild - Cartridge',
  '128017580568': 'Zelda Tears of the kingdom',
  '128031128860': 'Mario and Sonic Olympic Games'
};

function ebayApiCall(xmlRequest, callName, authToken, appId, devId, certId, hostname) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: hostname,
      path: '/ws/api.dll',
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-CERT-ID': certId,
        'X-EBAY-API-APP-ID': appId,
        'X-EBAY-API-DEV-ID': devId,
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-SITEID': '3',
        'Content-Type': 'text/xml',
        'Content-Length': Buffer.byteLength(xmlRequest)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(xmlRequest);
    req.end();
  });
}

function parseTag(xml, tag) {
  const regex = new RegExp(`<${tag}>(.*?)</${tag}>`, 'g');
  const matches = [];
  let m;
  while ((m = regex.exec(xml)) !== null) matches.push(m[1]);
  return matches;
}

async function getYesterdaySales(authToken, appId, devId, certId, hostname) {
  const now = new Date();
  // Nathan doesn't work weekends. On a Monday, cover Fri/Sat/Sun (3 days) instead
  // of just the standard 24 hours, so weekend sales aren't missed.
  const isMonday = now.getUTCDay() === 1; // Sunday=0, Monday=1 ... in UTC
  const daysToLookBack = isMonday ? 3 : 1;
  const yesterday = new Date(now.getTime() - daysToLookBack * 24 * 60 * 60 * 1000);
  const startTime = yesterday.toISOString();
  const endTime = now.toISOString();

  const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
        <eBayAuthToken>${authToken}</eBayAuthToken>
    </RequesterCredentials>
    <CreateTimeFrom>${startTime}</CreateTimeFrom>
    <CreateTimeTo>${endTime}</CreateTimeTo>
    <OrderStatus>Completed</OrderStatus>
    <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;

  try {
    const response = await ebayApiCall(xmlRequest, 'GetOrders', authToken, appId, devId, certId, hostname);
    const parsed = await parseGetOrdersXml(response);
    return { raw: response, parsed };
  } catch (err) {
    console.error('GetOrders failed:', err);
    return { raw: null, parsed: [] };
  }
}

async function parseGetOrdersXml(xmlString) {
  const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: false });
  const result = await parser.parseStringPromise(xmlString);

  const response = result.GetOrdersResponse;
  if (!response) return [];

  if (response.Ack !== 'Success' && response.Ack !== 'Warning') {
    console.error('GetOrders returned non-success Ack:', response.Ack);
    return [];
  }

  let orders = response.OrderArray && response.OrderArray.Order;
  if (!orders) return []; // No orders in the time window
  if (!Array.isArray(orders)) orders = [orders]; // xml2js doesn't wrap single items in an array

  const sales = [];

  orders.forEach(order => {
    let transactions = order.TransactionArray && order.TransactionArray.Transaction;
    if (!transactions) return;
    if (!Array.isArray(transactions)) transactions = [transactions];

    transactions.forEach(txn => {
      const itemId = txn.Item && txn.Item.ItemID;
      const quantity = parseInt(txn.QuantityPurchased, 10) || 1;
      const priceRaw = txn.TransactionPrice;
      const price = priceRaw ? parseFloat(typeof priceRaw === 'object' ? priceRaw._ : priceRaw) : 0;
      const gameName = itemIdToGameName[itemId] || (txn.Item && txn.Item.Title) || `Unknown item (${itemId})`;

      sales.push({ game: gameName, quantity, price });
    });
  });

  // Merge duplicate game entries (e.g. 2 separate orders for the same game same day)
  const merged = {};
  sales.forEach(s => {
    if (!merged[s.game]) {
      merged[s.game] = { game: s.game, quantity: 0, price: s.price };
    }
    merged[s.game].quantity += s.quantity;
  });

  return Object.values(merged);
}

async function getYesterdayTraffic(authToken, appId, devId, certId, hostname, itemIds) {
  // eBay's Traffic Report API requires the Analytics API (REST, not Trading API)
  // and uses OAuth (not Auth'n'Auth tokens) - this is a different auth flow.
  // TOMORROW: Confirm which token type works here, may need a separate
  // Client Credentials OAuth token generated fresh per call (2hr expiry).
  // Endpoint: GET https://api.ebay.com/sell/analytics/v1/traffic_report
  console.log('Traffic report - needs OAuth client credentials flow, not yet implemented');
  return [];
}

function buildEmailHtml(sales, traffic) {
  const totalItems = sales.reduce((sum, s) => sum + s.quantity, 0);
  const totalRevenue = sales.reduce((sum, s) => sum + (s.quantity * s.price), 0);
  const totalViews = traffic.reduce((sum, t) => sum + t.views, 0);

  const salesRows = sales.length > 0 ? sales.map(s => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;">${s.game}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right;color:#0d9488;font-weight:600;">${s.quantity}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right;color:#64748b;">£${s.price.toFixed(2)}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right;color:#059669;font-weight:600;">£${(s.quantity * s.price).toFixed(2)}</td>
    </tr>`).join('') : `<tr><td colspan="4" style="padding:16px 0;text-align:center;color:#94a3b8;">No sales data available yet — order parsing still being finalized.</td></tr>`;

  const trafficRows = traffic.length > 0 ? traffic.map(t => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;">${t.game}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right;color:#d97706;font-weight:600;">${t.views}</td>
    </tr>`).join('') : `<tr><td colspan="2" style="padding:16px 0;text-align:center;color:#94a3b8;">Traffic data not yet connected.</td></tr>`;

  return `
  <html><body style="font-family:-apple-system,sans-serif;background:#f8fafc;padding:20px;">
    <div style="max-width:600px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.08);">
      <div style="background:#0a0a0a;padding:32px 20px;text-align:center;color:white;">
        <img src="data:image/png;base64,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" width="64" height="64" alt="NGLH Trading" style="display:block;margin:0 auto 12px;border-radius:16px;">
        <h1 style="margin:0;font-size:26px;">Daily Report</h1>
        <p style="margin:4px 0 0;opacity:0.9;font-size:13px;color:#6bbdae;">NGLH Trading</p>
      </div>
      <div style="padding:32px 20px;">
        <div style="display:flex;gap:12px;margin-bottom:24px;">
          <div style="flex:1;background:#f0fdfa;border:1px solid #99f6e4;border-radius:12px;padding:14px;text-align:center;">
            <div style="font-size:11px;color:#0d9488;font-weight:600;text-transform:uppercase;">Items Sold</div>
            <div style="font-size:22px;font-weight:700;color:#0f766e;">${totalItems}</div>
          </div>
          <div style="flex:1;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:12px;padding:14px;text-align:center;">
            <div style="font-size:11px;color:#059669;font-weight:600;text-transform:uppercase;">Revenue</div>
            <div style="font-size:22px;font-weight:700;color:#047857;">£${totalRevenue.toFixed(2)}</div>
          </div>
          <div style="flex:1;background:#fef3c7;border:1px solid #fecaca;border-radius:12px;padding:14px;text-align:center;">
            <div style="font-size:11px;color:#d97706;font-weight:600;text-transform:uppercase;">Views</div>
            <div style="font-size:22px;font-weight:700;color:#92400e;">${totalViews}</div>
          </div>
        </div>
        <h2 style="font-size:16px;border-bottom:2px solid #e2e8f0;padding-bottom:10px;">Sales Breakdown</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;">
          <thead><tr>
            <th style="text-align:left;padding:8px 0;font-size:11px;color:#64748b;">Game</th>
            <th style="text-align:right;padding:8px 0;font-size:11px;color:#64748b;">Qty</th>
            <th style="text-align:right;padding:8px 0;font-size:11px;color:#64748b;">Price</th>
            <th style="text-align:right;padding:8px 0;font-size:11px;color:#64748b;">Total</th>
          </tr></thead>
          <tbody>${salesRows}</tbody>
        </table>
        <h2 style="font-size:16px;border-bottom:2px solid #e2e8f0;padding-bottom:10px;">Listing Traffic (Previous Day)</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;">
          <thead><tr>
            <th style="text-align:left;padding:8px 0;font-size:11px;color:#64748b;">Game</th>
            <th style="text-align:right;padding:8px 0;font-size:11px;color:#64748b;">Views</th>
          </tr></thead>
          <tbody>${trafficRows}</tbody>
        </table>
        <p style="font-size:12px;color:#94a3b8;text-align:center;">Shipping labels feature to be added once Production sync is confirmed working.</p>
      </div>
      <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px;text-align:center;font-size:12px;color:#94a3b8;">
        NGLH Trading • eBay Sync • Automated daily at 8:00 AM UK time
      </div>
    </div>
  </body></html>`;
}

async function sendViaResend(htmlContent, resendApiKey, toEmail) {
  const payload = JSON.stringify({
    from: 'NGLH Sync <onboarding@resend.dev>', // Replace with verified domain later
    to: [toEmail],
    subject: `eBay Sales Report - ${new Date().toLocaleDateString('en-GB')}`,
    html: htmlContent
  });

  const options = {
    hostname: 'api.resend.com',
    path: '/emails',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const handler = async function(event, context) {
  try {
    // These will come from Netlify environment variables (set up tomorrow)
    const authToken = process.env.EBAY_PRODUCTION_TOKEN || '';
    const appId = process.env.EBAY_PROD_APP_ID || '';
    const devId = process.env.EBAY_PROD_DEV_ID || '';
    const certId = process.env.EBAY_PROD_CERT_ID || '';
    const resendApiKey = process.env.RESEND_API_KEY || '';
    const toEmail = process.env.REPORT_EMAIL || 'cooki107@gmail.com';

    const hostname = 'api.ebay.com'; // Daily report always uses Production (real sales data)
    const salesResult = await getYesterdaySales(authToken, appId, devId, certId, hostname);
    const traffic = await getYesterdayTraffic(authToken, appId, devId, certId, hostname);
    // NOTE: salesResult.parsed is currently empty until GetOrders XML parsing is
    // built out tomorrow (see comment in getYesterdaySales above). Using an empty
    // array as a safe fallback so the email still generates without crashing.
    const sales = salesResult.parsed && salesResult.parsed.length > 0 ? salesResult.parsed : [];
    const html = buildEmailHtml(sales, traffic);

    if (!resendApiKey) {
      console.log('RESEND_API_KEY not set yet - email not sent. HTML generated successfully.');
      return { statusCode: 200, body: 'Report generated but not sent (no API key configured yet)' };
    }

    const result = await sendViaResend(html, resendApiKey, toEmail);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Error sending daily report:', error);
    return { statusCode: 500, body: error.message };
  }
};

module.exports.handler = schedule(CRON_SCHEDULE, handler);

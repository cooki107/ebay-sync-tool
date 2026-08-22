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
  '127951567807': 'Super Mario 3D Allstars',
  '128013972085': 'Super Mario 3D Allstars - Cartridge',
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
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
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
      <td style="padding:10px 0;border-bottom:1px solid #e2e8f0;text-align:right;color:#0066cc;font-weight:600;">${s.quantity}</td>
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
      <div style="background:linear-gradient(135deg,#0066cc,#0052a3);padding:32px 20px;text-align:center;color:white;">
        <div style="font-size:36px;margin-bottom:8px;">⚡</div>
        <h1 style="margin:0;font-size:26px;">Daily Report</h1>
        <p style="margin:4px 0 0;opacity:0.9;font-size:13px;">NGLH Trading</p>
      </div>
      <div style="padding:32px 20px;">
        <div style="display:flex;gap:12px;margin-bottom:24px;">
          <div style="flex:1;background:#f0f7ff;border:1px solid #bfdbfe;border-radius:12px;padding:14px;text-align:center;">
            <div style="font-size:11px;color:#0066cc;font-weight:600;text-transform:uppercase;">Items Sold</div>
            <div style="font-size:22px;font-weight:700;color:#0052a3;">${totalItems}</div>
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

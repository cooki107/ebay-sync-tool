// Plain (non-scheduled) Netlify Function powering the in-app "Listing
// Performance" panel. Surfaces weak converters - listings getting views but
// few/no sales - by pulling 30 days of traffic for EVERY mapped item
// (not just ones that sold), unlike the report emails' traffic table which
// only covers items that sold in that report's own period.
//
// POST body: { authToken, titleMapping } - titleMapping is the same
// { title: itemId } object index.html already maintains client-side, sent
// over so this function doesn't need its own copy to keep in sync.
// Gated on authToken matching the server's own production token, same as
// send-report-now.js's POST path.

const { getSalesForRange, getTraffic } = require('./report-shared');

const PERIOD_DAYS = 30;

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let authToken, titleMapping;
  try {
    ({ authToken, titleMapping } = JSON.parse(event.body || '{}'));
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid JSON body' }) };
  }

  const expectedToken = process.env.EBAY_PRODUCTION_TOKEN;
  if (!expectedToken || authToken !== expectedToken) {
    return { statusCode: 403, body: JSON.stringify({ success: false, error: 'Forbidden' }) };
  }

  if (!titleMapping || typeof titleMapping !== 'object' || Object.keys(titleMapping).length === 0) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'titleMapping is required' }) };
  }

  try {
    const appId = process.env.EBAY_PROD_APP_ID || '';
    const devId = process.env.EBAY_PROD_DEV_ID || '';
    const certId = process.env.EBAY_PROD_CERT_ID || '';
    const hostname = 'api.ebay.com';

    const now = new Date();
    const startTime = new Date(now.getTime() - PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const endTime = now.toISOString();

    const itemIdToTitle = {};
    Object.entries(titleMapping).forEach(([title, itemId]) => { itemIdToTitle[itemId] = title; });
    const allItemIds = Object.values(titleMapping);

    const [salesResult, traffic] = await Promise.all([
      getSalesForRange(startTime, endTime, authToken, appId, devId, certId, hostname),
      getTraffic(allItemIds, startTime, endTime)
    ]);
    const sales = salesResult.parsed || [];

    const listings = allItemIds.map(itemId => {
      const sale = sales.find(s => s.itemId === itemId);
      const trafficEntry = traffic.find(t => t.itemId === itemId);
      return {
        title: itemIdToTitle[itemId],
        itemId,
        views: trafficEntry ? trafficEntry.views : 0,
        qtySold: sale ? sale.quantity : 0,
        revenue: sale ? sale.quantity * sale.price : 0
      };
    });

    // Weakest converters first: most views per sale surfaces at the top,
    // with zero-sale-but-viewed listings ranking above everything else since
    // dividing by max(qtySold, 1) alone wouldn't otherwise distinguish "10
    // views, 0 sold" from "10 views, 1 sold".
    listings.sort((a, b) => {
      const aZero = a.qtySold === 0 && a.views > 0;
      const bZero = b.qtySold === 0 && b.views > 0;
      if (aZero !== bZero) return aZero ? -1 : 1;
      const aRatio = a.views / Math.max(a.qtySold, 1);
      const bRatio = b.views / Math.max(b.qtySold, 1);
      return bRatio - aRatio;
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, periodDays: PERIOD_DAYS, listings }) };
  } catch (error) {
    console.error('listing-performance failed:', error);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: error.message }) };
  }
};

// Scheduled Netlify Function - runs automatically every day
// Sends the 8am sales report email via Resend
//
// Known follow-up: the cron schedule below is fixed at 7am UTC, which is
// 8am UK time only during BST (summer). It'll need bumping to 8am UTC
// when the clocks go back in autumn.

const { schedule } = require('@netlify/functions');
const { getSalesForRange, getTraffic, getCostData, buildEmailHtml, sendViaResend } = require('./report-shared');

// UK is GMT (winter) or BST (summer, UTC+1). Netlify cron runs in UTC.
// 8am UK time = 7am UTC in summer (BST), 8am UTC in winter (GMT).
// Using 7am UTC as a starting point - adjust seasonally, or build DST logic later.
const CRON_SCHEDULE = '0 7 * * *'; // Every day at 07:00 UTC

async function getYesterdaySales(authToken, appId, devId, certId, hostname) {
  const now = new Date();
  // Nathan doesn't work weekends. On a Monday, cover Fri/Sat/Sun (3 days) instead
  // of just the standard 24 hours, so weekend sales aren't missed.
  const isMonday = now.getUTCDay() === 1; // Sunday=0, Monday=1 ... in UTC
  const daysToLookBack = isMonday ? 3 : 1;
  const yesterday = new Date(now.getTime() - daysToLookBack * 24 * 60 * 60 * 1000);
  const startTime = yesterday.toISOString();
  const endTime = now.toISOString();
  const result = await getSalesForRange(startTime, endTime, authToken, appId, devId, certId, hostname);
  return { ...result, startTime, endTime };
}

const handler = async function(event, context) {
  try {
    // Credentials come from Netlify environment variables
    const authToken = process.env.EBAY_PRODUCTION_TOKEN || '';
    const appId = process.env.EBAY_PROD_APP_ID || '';
    const devId = process.env.EBAY_PROD_DEV_ID || '';
    const certId = process.env.EBAY_PROD_CERT_ID || '';
    const resendApiKey = process.env.RESEND_API_KEY || '';
    const toEmail = process.env.REPORT_EMAIL || 'cooki107@gmail.com';

    const hostname = 'api.ebay.com'; // Daily report always uses Production (real sales data)
    const salesResult = await getYesterdaySales(authToken, appId, devId, certId, hostname);
    const costs = await getCostData();
    const sales = salesResult.parsed && salesResult.parsed.length > 0 ? salesResult.parsed : [];
    const traffic = await getTraffic(sales.map(s => s.itemId), salesResult.startTime, salesResult.endTime);
    const html = buildEmailHtml(sales, traffic, costs, {
      periodStart: salesResult.startTime,
      periodEnd: salesResult.endTime
    });

    if (!resendApiKey) {
      console.log('RESEND_API_KEY not set yet - email not sent. HTML generated successfully.');
      return { statusCode: 200, body: 'Report generated but not sent (no API key configured yet)' };
    }

    const totalRevenue = sales.reduce((sum, s) => sum + (s.quantity * s.price), 0);
    const dateStr = new Date().toLocaleDateString('en-GB');
    const subject = sales.length > 0
      ? `eBay Sales Report - ${dateStr} (£${totalRevenue.toFixed(2)})`
      : `eBay Sales Report - ${dateStr}`;

    const result = await sendViaResend(html, resendApiKey, toEmail, subject);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Error sending daily report:', error);
    return { statusCode: 500, body: error.message };
  }
};

module.exports.handler = schedule(CRON_SCHEDULE, handler);

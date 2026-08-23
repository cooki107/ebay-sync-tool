// Scheduled Netlify Function - runs automatically every Monday
// Sends a rollup of the previous 7 days' sales, using the same template as
// the daily report (see report-shared.js).

const { schedule } = require('@netlify/functions');
const { getSalesForRange, getTraffic, getCostData, buildEmailHtml, sendViaResend } = require('./report-shared');

// 8am UK time = 7am UTC in summer (BST), 8am UTC in winter (GMT) - same
// seasonal caveat as the daily report's cron schedule.
const CRON_SCHEDULE = '0 7 * * 1'; // Every Monday at 07:00 UTC

function formatRange(start, end) {
  const opts = { day: 'numeric', month: 'short' };
  return `${start.toLocaleDateString('en-GB', opts)} - ${end.toLocaleDateString('en-GB', opts)}`;
}

const handler = async function(event, context) {
  try {
    const authToken = process.env.EBAY_PRODUCTION_TOKEN || '';
    const appId = process.env.EBAY_PROD_APP_ID || '';
    const devId = process.env.EBAY_PROD_DEV_ID || '';
    const certId = process.env.EBAY_PROD_CERT_ID || '';
    const resendApiKey = process.env.RESEND_API_KEY || '';
    const toEmail = process.env.REPORT_EMAIL || 'cooki107@gmail.com';

    const hostname = 'api.ebay.com';
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const rangeLabel = formatRange(weekAgo, now);

    const salesResult = await getSalesForRange(weekAgo.toISOString(), now.toISOString(), authToken, appId, devId, certId, hostname);
    const traffic = await getTraffic();
    const costs = await getCostData();
    const sales = salesResult.parsed && salesResult.parsed.length > 0 ? salesResult.parsed : [];

    const html = buildEmailHtml(sales, traffic, costs, {
      reportTitle: 'Weekly Report',
      footerCadence: 'Automated weekly every Monday at 8:00 AM UK time',
      noSalesText: 'No sales recorded this week.',
      noSalesPreheader: 'No sales this week - nothing to report',
      preheaderPeriod: 'this week',
      dateRangeLabel: rangeLabel
    });

    if (!resendApiKey) {
      console.log('RESEND_API_KEY not set yet - email not sent. HTML generated successfully.');
      return { statusCode: 200, body: 'Report generated but not sent (no API key configured yet)' };
    }

    const totalRevenue = sales.reduce((sum, s) => sum + (s.quantity * s.price), 0);
    const subject = sales.length > 0
      ? `eBay Weekly Sales Report - ${rangeLabel} (£${totalRevenue.toFixed(2)})`
      : `eBay Weekly Sales Report - ${rangeLabel}`;

    const result = await sendViaResend(html, resendApiKey, toEmail, subject);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Error sending weekly report:', error);
    return { statusCode: 500, body: error.message };
  }
};

module.exports.handler = schedule(CRON_SCHEDULE, handler);

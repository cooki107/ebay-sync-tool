// Scheduled Netlify Function - runs automatically every Monday
// Sends a rollup of the previous 7 days' sales, using the same template as
// the daily report (see report-shared.js).

const { schedule } = require('@netlify/functions');
const { getSalesForRange, getTraffic, getCostData, buildEmailHtml, sendViaResend, isUkMorningRunTime } = require('./report-shared');

// Fires at both possible UTC hours for 8am UK time and lets isUkMorningRunTime()
// (see report-shared.js) skip whichever one isn't really 8am UK local right
// now - same DST-proofing as the daily report, no seasonal edits needed.
const CRON_SCHEDULE = '0 7,8 * * 1'; // Every Monday at 07:00 and 08:00 UTC

function formatRange(start, end) {
  const opts = { day: 'numeric', month: 'short' };
  return `${start.toLocaleDateString('en-GB', opts)} - ${end.toLocaleDateString('en-GB', opts)}`;
}

const handler = async function(event, context) {
  try {
    if (!isUkMorningRunTime(new Date())) {
      return { statusCode: 200, body: 'Skipped - not 8am UK local time on this invocation' };
    }

    const authToken = process.env.EBAY_PRODUCTION_TOKEN || '';
    const appId = process.env.EBAY_PROD_APP_ID || '';
    const devId = process.env.EBAY_PROD_DEV_ID || '';
    const certId = process.env.EBAY_PROD_CERT_ID || '';
    const resendApiKey = process.env.RESEND_API_KEY || '';
    const toEmail = process.env.REPORT_EMAIL || 'cooki107@gmail.com';

    const hostname = 'api.ebay.com';
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const rangeLabel = formatRange(weekAgo, now);

    const salesResult = await getSalesForRange(weekAgo.toISOString(), now.toISOString(), authToken, appId, devId, certId, hostname);
    const priorSalesResult = await getSalesForRange(twoWeeksAgo.toISOString(), weekAgo.toISOString(), authToken, appId, devId, certId, hostname);
    const costs = await getCostData();
    const sales = salesResult.parsed && salesResult.parsed.length > 0 ? salesResult.parsed : [];
    const traffic = await getTraffic(sales.map(s => s.itemId), weekAgo.toISOString(), now.toISOString());
    const priorSales = priorSalesResult.parsed || [];
    const priorRevenue = priorSales.reduce((sum, s) => sum + (s.quantity * s.price), 0);
    const priorItems = priorSales.reduce((sum, s) => sum + s.quantity, 0);

    const html = buildEmailHtml(sales, traffic, costs, {
      reportTitle: 'Weekly Report',
      footerCadence: 'Automated weekly every Monday at 8:00 AM UK time',
      noSalesText: 'No sales recorded this week.',
      noSalesPreheader: 'No sales this week - nothing to report',
      preheaderPeriod: 'this week',
      dateRangeLabel: rangeLabel,
      comparison: { label: 'last week', priorRevenue, priorItems },
      periodStart: weekAgo.toISOString(),
      periodEnd: now.toISOString()
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

// Scheduled Netlify Function - runs automatically on the 1st of every month
// Sends a rollup of the previous calendar month's sales, using the same
// template as the daily report (see report-shared.js).

const { schedule } = require('@netlify/functions');
const { getSalesForRange, getTraffic, getCostData, buildEmailHtml, sendViaResend } = require('./report-shared');

// 8am UK time = 7am UTC in summer (BST), 8am UTC in winter (GMT) - same
// seasonal caveat as the daily report's cron schedule.
const CRON_SCHEDULE = '0 7 1 * *'; // 07:00 UTC on the 1st of every month

// First and last instant (UTC) of the calendar month "monthsAgo" months before
// "now". monthsAgo=1 is last month (what the report covers), 2 is the month
// before that (used for the vs-prior-month comparison).
function getMonthRange(now, monthsAgo) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo + 1, 1, 0, 0, 0));
  return { start, end };
}

function formatMonthLabel(start) {
  return start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
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
    const { start, end } = getMonthRange(now, 1);
    const { start: priorStart, end: priorEnd } = getMonthRange(now, 2);
    const monthLabel = formatMonthLabel(start);
    // Short form ("Jun") rather than "last month" - the report itself covers
    // "last month" already, so reusing that phrase for the comparison would
    // read as comparing last month to itself.
    const priorMonthShortLabel = priorStart.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });

    const salesResult = await getSalesForRange(start.toISOString(), end.toISOString(), authToken, appId, devId, certId, hostname);
    const priorSalesResult = await getSalesForRange(priorStart.toISOString(), priorEnd.toISOString(), authToken, appId, devId, certId, hostname);
    const traffic = await getTraffic();
    const costs = await getCostData();
    const sales = salesResult.parsed && salesResult.parsed.length > 0 ? salesResult.parsed : [];
    const priorSales = priorSalesResult.parsed || [];
    const priorRevenue = priorSales.reduce((sum, s) => sum + (s.quantity * s.price), 0);
    const priorItems = priorSales.reduce((sum, s) => sum + s.quantity, 0);

    const html = buildEmailHtml(sales, traffic, costs, {
      reportTitle: 'Monthly Report',
      footerCadence: 'Automated monthly on the 1st at 8:00 AM UK time',
      noSalesText: 'No sales recorded last month.',
      noSalesPreheader: 'No sales last month - nothing to report',
      preheaderPeriod: 'last month',
      dateRangeLabel: monthLabel,
      comparison: { label: priorMonthShortLabel, priorRevenue, priorItems }
    });

    if (!resendApiKey) {
      console.log('RESEND_API_KEY not set yet - email not sent. HTML generated successfully.');
      return { statusCode: 200, body: 'Report generated but not sent (no API key configured yet)' };
    }

    const totalRevenue = sales.reduce((sum, s) => sum + (s.quantity * s.price), 0);
    const subject = sales.length > 0
      ? `eBay Monthly Sales Report - ${monthLabel} (£${totalRevenue.toFixed(2)})`
      : `eBay Monthly Sales Report - ${monthLabel}`;

    const result = await sendViaResend(html, resendApiKey, toEmail, subject);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Error sending monthly report:', error);
    return { statusCode: 500, body: error.message };
  }
};

module.exports.handler = schedule(CRON_SCHEDULE, handler);

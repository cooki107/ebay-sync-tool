// Scheduled Netlify Function - runs automatically every day
// Sends the 8am sales report email via Resend
//
// 8am UK time = 7am UTC in summer (BST), 8am UTC in winter (GMT). Netlify's
// cron can't itself shift with the clock change, so this fires at both
// possible UTC hours and isUkMorningRunTime() (see report-shared.js) skips
// the one that isn't really 8am UK time - stays correct across DST with no
// seasonal edits needed.

const { schedule } = require('@netlify/functions');
const { getSalesForRange, getTraffic, getCostData, buildEmailHtml, sendViaResend, isUkMorningRunTime } = require('./report-shared');

const CRON_SCHEDULE = '0 7,8 * * *'; // Every day at 07:00 and 08:00 UTC

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
  return { ...result, startTime, endTime, isMonday };
}

const handler = async function(event, context) {
  try {
    if (!isUkMorningRunTime(new Date())) {
      return { statusCode: 200, body: 'Skipped - not 8am UK local time on this invocation' };
    }

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

    // Monday's edition covers Fri/Sat/Sun rather than a single day - branded
    // as its own "Weekend Report" rather than a "Daily Report" so the copy
    // matches what it actually covers.
    const isWeekend = salesResult.isMonday;
    const html = buildEmailHtml(sales, traffic, costs, {
      reportTitle: isWeekend ? 'Weekend Report' : 'Daily Report',
      footerCadence: isWeekend
        ? 'Automated every Monday at 8:00 AM UK time, covering Friday-Sunday'
        : 'Automated daily at 8:00 AM UK time',
      noSalesText: isWeekend ? 'No sales recorded this weekend.' : 'No sales recorded yesterday.',
      noSalesPreheader: isWeekend ? 'No sales this weekend - nothing to report' : 'No sales yesterday - nothing to report today',
      preheaderPeriod: isWeekend ? 'this weekend' : 'yesterday',
      periodStart: salesResult.startTime,
      periodEnd: salesResult.endTime
    });

    if (!resendApiKey) {
      console.log('RESEND_API_KEY not set yet - email not sent. HTML generated successfully.');
      return { statusCode: 200, body: 'Report generated but not sent (no API key configured yet)' };
    }

    const totalRevenue = sales.reduce((sum, s) => sum + (s.quantity * s.price), 0);
    const dateStr = new Date().toLocaleDateString('en-GB');
    const subjectLabel = isWeekend ? 'Weekend Sales Report' : 'Sales Report';
    const subject = sales.length > 0
      ? `eBay ${subjectLabel} - ${dateStr} (£${totalRevenue.toFixed(2)})`
      : `eBay ${subjectLabel} - ${dateStr}`;

    const result = await sendViaResend(html, resendApiKey, toEmail, subject);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Error sending daily report:', error);
    return { statusCode: 500, body: error.message };
  }
};

module.exports.handler = schedule(CRON_SCHEDULE, handler);

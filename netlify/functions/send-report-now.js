// Plain (non-scheduled) Netlify Function for manually recovering a missed
// report. Netlify blocks direct public requests to a schedule()-wrapped
// function's URL (platform-level 403, before the function code even runs),
// so send-daily-report.js etc. can't be triggered by just visiting their
// URL. This is a normal function instead, reachable at its own URL, and
// guarded by ADMIN_REPORT_KEY (set in Netlify env vars) rather than the
// 8am-UK gate those use.
//
// Usage: /.netlify/functions/send-report-now?key=<ADMIN_REPORT_KEY>&type=daily
// type is one of daily (default), weekly, monthly. Optional from/to (ISO
// 8601, daily only) override the normal "last 24 hours" window - useful when
// recovering a missed run late, so the default now-24h-to-now range doesn't
// leave a gap covering whatever sold before the delay.
// ADMIN_REPORT_KEY is set directly in Netlify's dashboard (Site configuration
// -> Environment variables), not via this repo.

const { sendDailyReportEmail, sendWeeklyReportEmail, sendMonthlyReportEmail } = require('./report-shared');

const handler = async function(event, context) {
  const params = event.queryStringParameters || {};
  const expectedKey = process.env.ADMIN_REPORT_KEY;

  if (!expectedKey || params.key !== expectedKey) {
    return { statusCode: 403, body: 'Forbidden' };
  }

  try {
    if (params.type === 'weekly') return await sendWeeklyReportEmail();
    if (params.type === 'monthly') return await sendMonthlyReportEmail();
    return await sendDailyReportEmail(params.from, params.to);
  } catch (error) {
    console.error('Error sending manual report:', error);
    return { statusCode: 500, body: error.message };
  }
};

module.exports.handler = handler;

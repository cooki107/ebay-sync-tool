// Scheduled Netlify Function - runs automatically every day
// Sends the 8am sales report email via Resend
//
// 8am UK time = 7am UTC in summer (BST), 8am UTC in winter (GMT). Netlify's
// cron can't itself shift with the clock change, so this fires at both
// possible UTC hours and isUkMorningRunTime() (see report-shared.js) skips
// the one that isn't really 8am UK time - stays correct across DST with no
// seasonal edits needed.
//
// Report-building/sending logic itself lives in report-shared.js
// (sendDailyReportEmail), shared with send-report-now.js so a missed cron
// run can be recovered manually - see that file for why.

const { schedule } = require('@netlify/functions');
const { isUkMorningRunTime, sendDailyReportEmail } = require('./report-shared');

const CRON_SCHEDULE = '0 7,8 * * *'; // Every day at 07:00 and 08:00 UTC

const handler = async function(event, context) {
  try {
    if (!isUkMorningRunTime(new Date())) {
      return { statusCode: 200, body: 'Skipped - not 8am UK local time on this invocation' };
    }
    return await sendDailyReportEmail();
  } catch (error) {
    console.error('Error sending daily report:', error);
    return { statusCode: 500, body: error.message };
  }
};

module.exports.handler = schedule(CRON_SCHEDULE, handler);

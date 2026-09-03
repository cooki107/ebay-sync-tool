// Scheduled Netlify Function - runs automatically every Monday
// Sends a rollup of the previous 7 days' sales, using the same template as
// the daily report (see report-shared.js).
//
// Report-building/sending logic itself lives in report-shared.js
// (sendWeeklyReportEmail), shared with send-report-now.js so a missed cron
// run can be recovered manually - see that file for why.

const { schedule } = require('@netlify/functions');
const { isUkMorningRunTime, sendWeeklyReportEmail } = require('./report-shared');

// Fires at both possible UTC hours for 8am UK time and lets isUkMorningRunTime()
// (see report-shared.js) skip whichever one isn't really 8am UK local right
// now - same DST-proofing as the daily report, no seasonal edits needed.
const CRON_SCHEDULE = '0 7,8 * * 1'; // Every Monday at 07:00 and 08:00 UTC

const handler = async function(event, context) {
  try {
    if (!isUkMorningRunTime(new Date())) {
      return { statusCode: 200, body: 'Skipped - not 8am UK local time on this invocation' };
    }
    return await sendWeeklyReportEmail();
  } catch (error) {
    console.error('Error sending weekly report:', error);
    return { statusCode: 500, body: error.message };
  }
};

module.exports.handler = schedule(CRON_SCHEDULE, handler);

import { sendMonthlyReportNotifications } from '../src/modules/routine/routine.cron';

async function main() {
  console.log('🧪 Starting Monthly Report Notification Dispatcher Test...');
  await sendMonthlyReportNotifications();
  console.log('🎉 Notification dispatch completed successfully!');
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exitCode = 1;
});

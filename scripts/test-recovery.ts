import { SheetsService } from '../src/modules/sheets/sheets.service';
import { prisma } from '../src/config/prisma';

async function main() {
  console.log('🧪 Starting Spreadsheet Recovery Integration Tests...');

  // 1. Fetch a test messaging account
  const account = await prisma.messagingAccount.findFirst({
    include: { user: true }
  });
  if (!account) {
    console.error('❌ No MessagingAccount found in the database. Please register/create one first.');
    return;
  }
  const messagingAccountId = account.id;
  const userId = account.userId;
  console.log(`ℹ️ Using MessagingAccount ID: ${messagingAccountId}, User ID: ${userId}`);

  // Store original values to restore after test
  const originalSpreadsheetId = account.spreadsheetId;
  const originalDriveFolderId = account.googleDriveFolderId;

  try {
    // 2. Test checkIfSpreadsheetExists with a non-existent ID
    console.log('\n🧪 Testing: SheetsService.checkIfSpreadsheetExists with a dummy/deleted ID');
    const dummyId = 'dummy-spreadsheet-id-12345';
    const exists = await SheetsService.checkIfSpreadsheetExists(userId, dummyId);
    console.log(`💡 Spreadsheet check result for dummy ID: ${exists}`);
    if (exists === false) {
      console.log('✅ Success: Properly returned false for non-existent spreadsheet ID.');
    } else {
      console.error('❌ Failed: Expected false but got:', exists);
    }

    // 3. Test handleOAuthError with a 404/notfound error
    console.log('\n🧪 Testing: SheetsService.handleOAuthError (404/notFound Mock)');
    
    // Temporarily set a dummy spreadsheet ID in database to test if it gets cleared
    await prisma.messagingAccount.update({
      where: { id: messagingAccountId },
      data: { spreadsheetId: 'dummy-id-for-clear-test' }
    });

    const mock404Error = new Error('Requested entity was not found.');
    (mock404Error as any).code = 404;

    console.log('Triggering handleOAuthError with 404 error...');
    // We invoke the private/public handleOAuthError method. Since it's private in sheets.service.ts,
    // wait, is it private or public?
    // Let's check: in sheets.service.ts, we have:
    // `private static async handleOAuthError(error: any, messagingAccountId: string)`
    // Oh, it is private! Since it's private, we can trigger it indirectly by appending a transaction
    // with a failing spreadsheetId, OR we can temporarily cast to any to call it.
    // Let's cast to any: (SheetsService as any).handleOAuthError(mock404Error, messagingAccountId)
    await (SheetsService as any).handleOAuthError(mock404Error, messagingAccountId);

    // Verify database record
    const updatedAccount = await prisma.messagingAccount.findUnique({
      where: { id: messagingAccountId },
      select: { spreadsheetId: true }
    });

    console.log(`💡 DB spreadsheetId after 404 error: ${updatedAccount?.spreadsheetId}`);
    if (updatedAccount?.spreadsheetId === null) {
      console.log('✅ Success: spreadsheetId in database was reset to null.');
    } else {
      console.error('❌ Failed: spreadsheetId was not reset to null!');
    }

  } finally {
    // Restore original values
    await prisma.messagingAccount.update({
      where: { id: messagingAccountId },
      data: {
        spreadsheetId: originalSpreadsheetId,
        googleDriveFolderId: originalDriveFolderId
      }
    });
    console.log('\nℹ️ Original messaging account fields restored.');
  }

  console.log('\n🎉 Recovery integration tests completed!');
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exitCode = 1;
});

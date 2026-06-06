import { SheetsService } from '../src/modules/sheets/sheets.service';
import { prisma } from '../src/config/prisma';

async function main() {
  console.log('🧪 Starting Spreadsheet Recovery Integration Tests...');

  // 1. Fetch all candidate messaging accounts
  const candidateAccounts = await prisma.messagingAccount.findMany({
    where: { NOT: { spreadsheetId: null } },
    include: { user: true }
  });

  if (candidateAccounts.length === 0) {
    console.error('❌ No MessagingAccount with active spreadsheetId found in the database.');
    return;
  }

  let testAccount = null;

  // Find an account that has a valid OAuth token
  for (const account of candidateAccounts) {
    try {
      console.log(`Checking token validity for account ID: ${account.id} (user: ${account.userId})...`);
      // Trigger a light authenticating action
      await (SheetsService as any).authenticateUser(account.userId);
      testAccount = account;
      break;
    } catch (err) {
      console.warn(`⚠️ Account ${account.id} token is expired/revoked:`, (err as any).message || err);
    }
  }

  if (!testAccount) {
    console.log('ℹ️ No candidate account has a currently valid token. Using the first one as fallback.');
    testAccount = candidateAccounts[0];
  }

  const messagingAccountId = testAccount.id;
  const userId = testAccount.userId;
  console.log(`ℹ️ Selected Test MessagingAccount ID: ${messagingAccountId}, User ID: ${userId}`);

  // Store original values to restore after test
  const originalSpreadsheetId = testAccount.spreadsheetId;
  const originalDriveFolderId = testAccount.googleDriveFolderId;

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

  } catch (err: any) {
    console.error('❌ Integration check failed due to error:', err.message || err);
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

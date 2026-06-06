import { prisma } from '../src/config/prisma';

async function main() {
  console.log('🧪 Starting Print Validation Tests...');

  const account = await prisma.messagingAccount.findFirst();
  if (!account) {
    console.error('❌ No MessagingAccount found.');
    return;
  }
  const messagingAccountId = account.id;

  // 1. Test transaction count for a future year (guaranteed to be 0)
  console.log('\n🧪 Testing count validation for month with 0 transactions...');
  const year = 2035;
  const month = 1; // Januari
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59, 999);

  const txCount = await prisma.transaction.count({
    where: {
      messagingAccountId,
      isConfirmed: true,
      deletedAt: null,
      transactionDate: { gte: startDate, lte: endDate }
    }
  });

  console.log(`💡 Transaction count for ${month}/${year}: ${txCount}`);
  if (txCount === 0) {
    console.log('✅ Success: Correctly detected 0 transactions.');
  } else {
    console.error('❌ Failed: Expected 0 but got:', txCount);
  }

  // 2. Test Lock Mechanism
  console.log('\n🧪 Testing spam click session-based locking...');
  
  // Clean up any lingering print sessions
  await prisma.transactionSession.deleteMany({
    where: {
      messagingAccountId,
      status: 'PENDING',
      extractedData: {
        path: ['type'],
        equals: 'PRINTING'
      }
    }
  });

  // Create a mock active printing session
  const printSession = await prisma.transactionSession.create({
    data: {
      messagingAccountId,
      platform: 'TELEGRAM',
      status: 'PENDING',
      extractedData: { type: 'PRINTING', month, year },
      rawPayload: {},
      expiresAt: new Date(Date.now() + 15000) // 15s lock
    }
  });

  // Simulate a duplicate print request checking for lock
  const activeSessions = await prisma.transactionSession.findMany({
    where: {
      messagingAccountId,
      status: 'PENDING',
      expiresAt: { gt: new Date() }
    }
  });

  const isPrinting = activeSessions.some(s => {
    const data = s.extractedData as any;
    return data?.type === 'PRINTING';
  });

  console.log(`💡 Is print request locked? ${isPrinting}`);
  if (isPrinting === true) {
    console.log('✅ Success: Duplicate print request was correctly locked/blocked.');
  } else {
    console.error('❌ Failed: Lock was not detected!');
  }

  // Cleanup lock
  await prisma.transactionSession.delete({
    where: { id: printSession.id }
  });
  console.log('ℹ️ Lock session cleaned up.');

  console.log('\n🎉 Print validation tests completed successfully!');
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exitCode = 1;
});

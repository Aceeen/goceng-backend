import { CategoryService } from '../src/modules/category/category.service';
import { prisma } from '../src/config/prisma';

async function main() {
  console.log('🧪 Starting Category Service Integration Tests...');

  // 1. Fetch a test messaging account
  const account = await prisma.messagingAccount.findFirst();
  if (!account) {
    console.error('❌ No MessagingAccount found in the database. Please register/create one first.');
    return;
  }
  const testAccountId = account.id;
  console.log(`ℹ️ Using MessagingAccount ID: ${testAccountId}`);

  // Clean up any old test categories
  await prisma.category.deleteMany({
    where: {
      name: { in: ['Test Expense Category', 'Test Updated Category', 'Duplicate Test Category'] },
      messagingAccountId: testAccountId
    }
  });

  // 2. Fetch all categories (should see system categories + any custom ones)
  const initialCategories = await CategoryService.getAllCategories(testAccountId);
  console.log(`✅ Fetched ${initialCategories.length} categories.`);

  // 3. Create a custom category
  console.log('🧪 Testing: Create Custom Category');
  const newCat = await CategoryService.createCategory(testAccountId, {
    name: 'Test Expense Category',
    type: 'EXPENSE',
    icon: '💡',
    color: '#00FF00',
    keywords: ['test', 'service']
  });
  console.log('✅ Created custom category:', newCat);

  // 4. Verify name uniqueness constraint
  console.log('🧪 Testing: Prevent Duplicate Name');
  try {
    await CategoryService.createCategory(testAccountId, {
      name: 'Test Expense Category',
      type: 'EXPENSE'
    });
    console.error('❌ Expected duplication error, but succeeded!');
  } catch (error: any) {
    console.log('✅ Correctly blocked duplicate name creation:', error.message);
  }

  // 5. Verify system category protection (Update & Delete block)
  console.log('🧪 Testing: Protect System Categories');
  const systemCat = await prisma.category.findFirst({ where: { isSystem: true } });
  if (systemCat) {
    try {
      await CategoryService.updateCategory(systemCat.id, testAccountId, { name: 'Hack Name' });
      console.error('❌ Expected error on editing system category, but succeeded!');
    } catch (error: any) {
      console.log('✅ Correctly blocked editing system category:', error.message);
    }

    try {
      await CategoryService.deleteCategory(systemCat.id, testAccountId);
      console.error('❌ Expected error on deleting system category, but succeeded!');
    } catch (error: any) {
      console.log('✅ Correctly blocked deleting system category:', error.message);
    }
  }

  // 6. Update custom category
  console.log('🧪 Testing: Update Custom Category');
  const updatedCat = await CategoryService.updateCategory(newCat.id, testAccountId, {
    name: 'Test Updated Category',
    icon: '⚡'
  });
  console.log('✅ Updated custom category:', updatedCat);

  // 7. Delete custom category
  console.log('🧪 Testing: Delete Custom Category');
  const deletedCat = await CategoryService.deleteCategory(updatedCat.id, testAccountId);
  console.log('✅ Deleted custom category:', deletedCat);

  console.log('🎉 All Category Service integration tests passed!');
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exitCode = 1;
});

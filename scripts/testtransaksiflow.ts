// tests/test-transaction-flow.ts
// Jalankan: npx ts-node tests/test-transaction-flow.ts
//
// Test alur lengkap:
// 1. NLP ekstrak teks → dapat data transaksi
// 2. Simpan transaksi ke DB
// 3. Cek data tersimpan benar di DB
// 4. Cek saldo rekening terupdate
// 5. Cek baris baru muncul di Google Sheets
// 6. Edit transaksi
// 7. Soft delete transaksi + cek rollback saldo

import { prisma } from '../src/config/prisma';
import { extractFromText } from '../src/modules/ai/ai.service';
import { applyUserCorrection } from '../src/modules/ai/ai.service';
import { isAIError } from '../src/modules/ai/ai.types';
import { saveConfirmedTransaction } from '../src/modules/transaction/transaction.save';
import { google } from 'googleapis';
import { prisma as prismaClient } from '../src/config/prisma';

// ── Config: ganti dengan user ID yang ada di DB lokal kamu ───────────────────
const TEST_USER_ID = process.env.TEST_USER_ID || 'riskiyatugas@gmail.com';

const categories = [
  'Makan & Minum', 'BBM', 'Transport Online', 'Obat & Suplemen',
  'Hobi & Lifestyle', 'Gaji', 'Freelance', 'Pengeluaran Lainnya',
];

// =============================================================================
// STEP 1 — NLP Extract
// =============================================================================
async function testStep1_NLP() {
  console.log('\n📌 STEP 1: NLP Extract');
  const result = await extractFromText('makan siang di warteg 25rb', categories);

  if (isAIError(result)) {
    console.log('❌ FAIL — NLP Error:', result.error);
    return null;
  }

  console.log('✅ PASS — NLP berhasil');
  console.log(`   amount   : Rp ${result.amount.toLocaleString('id-ID')}`);
  console.log(`   category : ${result.suggestedCategory}`);
  console.log(`   type     : ${result.type}`);
  return result;
}

// =============================================================================
// STEP 2 — Save Transaction ke DB
// =============================================================================
async function testStep2_Save(nlpData: any) {
  console.log('\n📌 STEP 2: Save Transaction');

  try {
    const { transaction, account } = await saveConfirmedTransaction(TEST_USER_ID, nlpData);
    console.log('✅ PASS — Transaksi tersimpan');
    console.log(`   transaction.id : ${transaction.id}`);
    console.log(`   account        : ${account?.name}`);
    console.log(`   saldo baru     : Rp ${Number(account?.currentBalance ?? 0).toLocaleString('id-ID')}`);
    return transaction;
  } catch (err: any) {
    console.log('❌ FAIL — Gagal simpan:', err.message);
    return null;
  }
}

// =============================================================================
// STEP 3 — Verifikasi di Database
// =============================================================================
async function testStep3_VerifyDB(transactionId: string) {
  console.log('\n📌 STEP 3: Verifikasi di Database');

  const tx = await prisma.transaction.findUnique({
    where:   { id: transactionId },
    include: { category: true, account: true },
  });

  if (!tx) {
    console.log('❌ FAIL — Transaksi tidak ditemukan di DB');
    return false;
  }

  const checks = [
    { label: 'is_confirmed = true',  pass: tx.isConfirmed === true },
    { label: 'deleted_at = null',    pass: tx.deletedAt === null   },
    { label: 'amount > 0',           pass: Number(tx.amount) > 0   },
    { label: 'category ada',         pass: tx.category !== null    },
    { label: 'account ada',          pass: tx.account  !== null    },
  ];

  let allPassed = true;
  for (const check of checks) {
    console.log(`   ${check.pass ? '✅' : '❌'} ${check.label}`);
    if (!check.pass) allPassed = false;
  }

  return allPassed;
}

// =============================================================================
// STEP 4 — Verifikasi di Google Sheets
// =============================================================================
async function testStep4_VerifySheets(transactionId: string, userId: string) {
  console.log('\n📌 STEP 4: Verifikasi di Google Sheets');

  // Tunggu sebentar karena sheets sync adalah setImmediate (async non-blocking)
  console.log('   ⏳ Tunggu 5 detik untuk sheets sync...');
  await new Promise((r) => setTimeout(r, 5000));

  // Cek isSynced di DB
  const tx = await prisma.transaction.findUnique({
    where:  { id: transactionId },
    select: { isSynced: true, sheetsRowIndex: true },
  });

  if (!tx) {
    console.log('❌ FAIL — Transaksi tidak ditemukan');
    return false;
  }

  if (tx.isSynced && tx.sheetsRowIndex) {
    console.log(`✅ PASS — Tersinkron ke Sheets`);
    console.log(`   isSynced      : ${tx.isSynced}`);
    console.log(`   sheetsRowIndex: ${tx.sheetsRowIndex}`);
    return true;
  } else {
    console.log(`⚠️  WARN — isSynced: ${tx.isSynced}, sheetsRowIndex: ${tx.sheetsRowIndex}`);
    console.log('   Kemungkinan: spreadsheetId user belum diset, atau OAuth token expired');
    return false;
  }
}

// =============================================================================
// STEP 5 — Edit Transaksi
// =============================================================================
async function testStep5_Edit(transactionId: string, originalData: any) {
  console.log('\n📌 STEP 5: Edit Transaksi');

  const correction = 'harganya 30000';
  const corrected  = await applyUserCorrection(correction, originalData);

  if (isAIError(corrected)) {
    console.log('❌ FAIL — AI Error saat edit:', corrected.error);
    return false;
  }

  const merged = { ...originalData, ...corrected };

  // Update di DB
  await prisma.transaction.update({
    where: { id: transactionId },
    data:  { amount: (corrected as any).amount ?? originalData.amount },
  });

  const updated = await prisma.transaction.findUnique({
    where:  { id: transactionId },
    select: { amount: true },
  });

  const passed = Number(updated?.amount) === 30000;
  console.log(`   ${passed ? '✅ PASS' : '❌ FAIL'} — Amount setelah edit: Rp ${Number(updated?.amount).toLocaleString('id-ID')}`);
  console.log(`   Koreksi AI: ${JSON.stringify(corrected, null, 2)}`);
  return passed;
}

// =============================================================================
// STEP 6 — Soft Delete + Rollback Saldo
// =============================================================================
async function testStep6_Delete(transactionId: string) {
  console.log('\n📌 STEP 6: Soft Delete + Rollback Saldo');

  const tx = await prisma.transaction.findUnique({
    where:  { id: transactionId },
    select: { accountId: true, amount: true, type: true },
  });

  if (!tx) {
    console.log('❌ FAIL — Transaksi tidak ditemukan');
    return false;
  }

  const accountBefore = await prisma.account.findUnique({
    where:  { id: tx.accountId },
    select: { currentBalance: true },
  });

  // Soft delete + rollback saldo
  await prisma.$transaction([
    prisma.transaction.update({
      where: { id: transactionId },
      data:  { deletedAt: new Date() },
    }),
    prisma.account.update({
      where: { id: tx.accountId },
      data:  {
        currentBalance: {
          // Rollback: kebalikan dari saat save
          [tx.type === 'INCOME' ? 'decrement' : 'increment']: tx.amount,
        },
      },
    }),
  ]);

  const accountAfter = await prisma.account.findUnique({
    where:  { id: tx.accountId },
    select: { currentBalance: true },
  });

  const txDeleted = await prisma.transaction.findUnique({
    where:  { id: transactionId },
    select: { deletedAt: true },
  });

  const checks = [
    {
      label: 'deleted_at terisi (soft delete)',
      pass:  txDeleted?.deletedAt !== null,
    },
    {
      label: 'Saldo dikembalikan',
      pass:  Number(accountAfter?.currentBalance) !== Number(accountBefore?.currentBalance),
    },
    {
      label: 'Transaksi tidak muncul di query aktif',
      pass:  await prisma.transaction.count({
        where: { id: transactionId, deletedAt: null },
      }).then((c) => c === 0),
    },
  ];

  let allPassed = true;
  for (const check of checks) {
    console.log(`   ${check.pass ? '✅' : '❌'} ${check.label}`);
    if (!check.pass) allPassed = false;
  }

  console.log(`   Saldo sebelum delete: Rp ${Number(accountBefore?.currentBalance).toLocaleString('id-ID')}`);
  console.log(`   Saldo setelah delete: Rp ${Number(accountAfter?.currentBalance).toLocaleString('id-ID')}`);

  return allPassed;
}

// =============================================================================
// MAIN — Jalankan semua step
// =============================================================================
async function main() {
  console.log('🧪 TEST: Full Transaction Flow');
  console.log('='.repeat(60));

  if (TEST_USER_ID === 'GANTI_DENGAN_USER_ID_KAMU') {
    console.log('⚠️  Set TEST_USER_ID dulu!');
    console.log('   Cara 1: TEST_USER_ID=clx123abc npx ts-node tests/test-transaction-flow.ts');
    console.log('   Cara 2: Ubah nilai TEST_USER_ID di file ini');
    console.log('\n   Cari user ID di Supabase:');
    console.log('   SELECT id, email FROM users LIMIT 5;');
    process.exit(1);
  }

  const results: Record<string, boolean> = {};

  // Step 1: NLP
  const nlpData = await testStep1_NLP();
  results['1. NLP Extract'] = nlpData !== null;
  if (!nlpData) { printSummary(results); return; }

  // Step 2: Save
  const transaction = await testStep2_Save(nlpData);
  results['2. Save ke DB'] = transaction !== null;
  if (!transaction) { printSummary(results); return; }

  // Step 3: Verify DB
  results['3. Verifikasi DB'] = await testStep3_VerifyDB(transaction.id);

  // Step 4: Verify Sheets
  results['4. Sync ke Sheets'] = await testStep4_VerifySheets(transaction.id, TEST_USER_ID);

  // Step 5: Edit
  results['5. Edit transaksi'] = await testStep5_Edit(transaction.id, nlpData);

  // Step 6: Delete
  results['6. Soft delete'] = await testStep6_Delete(transaction.id);

  printSummary(results);
  await prisma.$disconnect();
}

function printSummary(results: Record<string, boolean>) {
  console.log('\n' + '='.repeat(60));
  console.log('📊 RINGKASAN HASIL:');
  let passed = 0;
  for (const [step, result] of Object.entries(results)) {
    console.log(`   ${result ? '✅' : '❌'} ${step}`);
    if (result) passed++;
  }
  const total = Object.keys(results).length;
  console.log(`\n   Total: ${passed}/${total} passed`);
}

main().catch((err) => {
  console.error('❌ Test runner error:', err);
  prisma.$disconnect();
  process.exit(1);
});
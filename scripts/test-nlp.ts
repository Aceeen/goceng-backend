/// <reference types="node" />

// tests/test-nlp.ts
// Jalankan: npx ts-node tests/test-nlp.ts

// // tests/test-nlp.ts
// // Jalankan: npx ts-node tests/test-nlp.ts
// path aktual Anda sekarang ada di folder scripts
// Jalankan: npx tsx .\scripts\test-nlp.ts

// import { extractFromText } from '../src/modules/ai/ai.service';
// import { extractFromText, getAIProviderNames } from '../src/modules/ai/ai.service';
import { extractFromText, getNLPProviders } from '../src/modules/ai/ai.service';

import { isAIError } from '../src/modules/ai/ai.types';

const categories = [
  'Makan & Minum', 'Snack & Minuman', 'Belanja Dapur',
  'BBM', 'Transport Online', 'Mobilitas Tambahan', 'Perawatan Kendaraan',
  'Biaya Medis', 'Obat & Suplemen', 'Asuransi',
  'Utilitas Rumah', 'Telekomunikasi',
  'Fashion', 'Perawatan Diri', 'Rekreasi & Hiburan', 'Hobi & Lifestyle',
  'Gaji', 'Freelance', 'Bisnis', 'Hasil Investasi', 'Pemasukan Lainnya',
  'Zakat & Sedekah', 'Cicilan', 'Pengeluaran Lainnya',
];

const samples = [
  // ── Normal cases ──────────────────────────────────────────────────────────
  { input: 'makan siang di warteg 15rb',       expect: { category: 'Makan & Minum',    type: 'EXPENSE' } },
  { input: 'gajian bulan ini 2.500.000',       expect: { category: 'Gaji',             type: 'INCOME'  } },
  { input: 'bayar grab 22 ribu',               expect: { category: 'Transport Online', type: 'EXPENSE' } },
  { input: 'beli obat di apotek 35rb',         expect: { category: 'Obat & Suplemen',  type: 'EXPENSE' } },
  { input: 'bayar netflix bulan ini 54000',    expect: { category: 'Hobi & Lifestyle', type: 'EXPENSE' } },
  { input: 'transfer masuk dari klien 1.5jt',  expect: { category: 'Freelance',        type: 'INCOME'  } },
  { input: 'parkir mall 5000',                 expect: { category: 'Mobilitas Tambahan', type: 'EXPENSE' } },
  // ── Edge cases ────────────────────────────────────────────────────────────
  { input: 'tadi habis makan',                 expect: { error: 'NO_AMOUNT' } },
  { input: 'beli sesuatu',                     expect: { error: 'NO_AMOUNT' } },
];

const DELAY_BETWEEN_REQUEST_MS = 5000;

// jalankan satu sample dulu agar tidak langsung spam 9 request
const RUN_ONLY_FIRST_SAMPLE = true;

// const activeSamples = samples;
const activeSamples = RUN_ONLY_FIRST_SAMPLE ? [samples[0]] : samples;

async function main() {
  console.log('🧪 TEST: NLP Text Extraction');
  console.log('='.repeat(60));

  // tampilkan chain provider aktif
  // console.log('🔗 NLP provider chain:', getAIProviderNames().join(' -> '));
  console.log('🔗 NLP provider chain:', getNLPProviders().join(' -> '));

  let passed = 0;
  let failed = 0;

  // for (const sample of samples) {
  for (const sample of activeSamples) {
    console.log(`\n📝 INPUT: "${sample.input}"`);

    const result = await extractFromText(sample.input, categories);

    if (isAIError(result)) {
      const expectError = (sample.expect as any).error;
      if (expectError && result.error === expectError) {
        console.log(`✅ PASS — Error seperti yang diharapkan: ${result.error}`);
        passed++;
      } else {
        console.log(`❌ FAIL — AI Error tidak terduga: ${result.error}`);
        console.log(JSON.stringify(result, null, 2));
        failed++;
      }

      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_REQUEST_MS));
      continue;
    }

    // Cek kategori dan type
    const expectCategory = (sample.expect as any).category;
    const expectType     = (sample.expect as any).type;
    const categoryMatch  = !expectCategory || result.suggestedCategory === expectCategory;
    const typeMatch      = !expectType     || result.type === expectType;

    if (categoryMatch && typeMatch) {
      console.log(`✅ PASS — ${result.type} | Rp ${result.amount.toLocaleString('id-ID')} | ${result.suggestedCategory} | confidence: ${Math.round(result.confidence * 100)}%`);
      passed++;
    } else {
      console.log(`⚠️  PARTIAL — ${result.type} | Rp ${result.amount.toLocaleString('id-ID')} | ${result.suggestedCategory}`);
      if (!categoryMatch) console.log(`   Expected category: "${expectCategory}", got: "${result.suggestedCategory}"`);
      if (!typeMatch)     console.log(`   Expected type: "${expectType}", got: "${result.type}"`);
      failed++;
    }

    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_REQUEST_MS));
  }

  // for (const sample of samples) {
  //   console.log(`\n📝 INPUT: "${sample.input}"`);
  //   const result = await extractFromText(sample.input, categories);
  //   // ... handling ...
  //
  //   // ← tambah ini: tunggu 5 detik antar request
  //   await new Promise((r) => setTimeout(r, 5000));
  // }

  console.log('\n' + '='.repeat(60));
  // console.log(`📊 HASIL: ${passed} passed, ${failed} failed dari ${samples.length} test`);
  console.log(`📊 HASIL: ${passed} passed, ${failed} failed dari ${activeSamples.length} test`);
}

main().catch((err) => {
  console.error('❌ Test runner error:', err);

  // process.exit(1);
  process.exitCode = 1;
});
/// <reference types="node" />

// import { applyUserCorrection } from '../src/modules/ai/ai.service';
// import { applyUserCorrection, getAIProviderNames } from '../src/modules/ai/ai.service';
import { applyUserCorrection, getEditProviders } from '../src/modules/ai/ai.service';

import { isAIError } from '../src/modules/ai/ai.types';

const currentData = {
  type: 'EXPENSE',
  amount: 58600,
  description: 'Belanja di supermarket',
  merchantName: 'SAKINAH SUPERMARKET',
  transactionDate: '2026-04-15',
  suggestedCategory: 'Belanja Dapur',
};

const corrections = [
  // 'totalnya bukan 58600, tapi 65000',
  // 'kategorinya bukan Belanja Dapur, tapi Makan & Minum',
  // 'merchantnya bukan SAKINAH SUPERMARKET, tapi ALFAMART',
  // 'tanggalnya bukan 2026-04-15, tapi 2026-04-14',
  { input: 'totalnya bukan 58600, tapi 65000', expect: { amount: 65000 } },
  { input: 'kategorinya bukan Belanja Dapur, tapi Makan & Minum', expect: { suggestedCategory: 'Makan & Minum' } },
  { input: 'merchantnya bukan SAKINAH SUPERMARKET, tapi ALFAMART', expect: { merchantName: 'ALFAMART' } },
  { input: 'tanggalnya bukan 2026-04-15, tapi 2026-04-14', expect: { transactionDate: '2026-04-14' } },
];

// jalankan satu correction dulu agar hemat request
const RUN_ONLY_FIRST_CORRECTION = true;

// const activeCorrections = corrections;
const activeCorrections = RUN_ONLY_FIRST_CORRECTION ? [corrections[0]] : corrections;

const DELAY_BETWEEN_REQUEST_MS = 5000;

async function main() {
  console.log('🧪 TEST: Edit / Apply User Correction');
  console.log('='.repeat(60));

  // console.log('🔗 Edit provider chain:', getAIProviderNames().join(' -> '));
  // console.log(
  //   '🔗 Edit provider chain:',
  //   getAIProviderNames().filter((name) => !name.includes('ocr.space')).join(' -> ')
  // );
  console.log('🔗 Edit provider chain:', getEditProviders().join(' -> '));

  console.log('📦 CURRENT DATA:');
  console.log(JSON.stringify(currentData, null, 2));

  for (const correction of activeCorrections) {
    console.log('\n' + '-'.repeat(60));
    // console.log(`✏️  CORRECTION: "${correction}"`);
    console.log(`✏️  CORRECTION: "${correction.input}"`);

    // const result = await applyUserCorrection(correction, currentData);
    const result = await applyUserCorrection(correction.input, currentData);

    if (isAIError(result)) {
      console.log('❌ AI Error');
      console.log(JSON.stringify(result, null, 2));

      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_REQUEST_MS));
      continue;
    }

    console.log('✅ EDIT RESULT');
    console.log(JSON.stringify(result, null, 2));

    const matches = Object.entries(correction.expect).every(
      ([key, value]) => (result as any)[key] === value
    );

    if (matches) {
      console.log('✅ EXPECTATION MATCH');
    } else {
      console.log('⚠️ EXPECTATION MISMATCH');
      console.log('Expected:', correction.expect);
    }

    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_REQUEST_MS));
  }

  console.log('\n' + '='.repeat(60));
  // console.log(`📊 TOTAL CORRECTIONS TESTED: ${corrections.length}`);
  console.log(`📊 TOTAL CORRECTIONS TESTED: ${activeCorrections.length}`);
}

main().catch((err) => {
  console.error('❌ Test runner error:', err);

  // process.exit(1);
  process.exitCode = 1;
});
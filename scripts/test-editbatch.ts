import { applyUserCorrection } from '../src/modules/ai/ai.service';
import { isAIError } from '../src/modules/ai/ai.types';

async function main() {
  const currentData = {
    type: 'EXPENSE',
    amount: 50000,
    description: 'bensin',
    merchantName: 'SPBU',
    transactionDate: '2026-04-22',
    suggestedCategory: 'BBM',
  };

  const samples = [
    'harganya jadi 55000',
    'tanggalnya 2026-04-21',
    'merchantnya Shell',
    'ubah jadi pemasukan 100000',
    'kategori tetap BBM',
  ];

  for (const correction of samples) {
    console.log('\n========================');
    console.log('INPUT:', correction);

    const result = await applyUserCorrection(correction, currentData);

    if (isAIError(result)) {
      console.log('❌ AI Error');
      console.log(JSON.stringify(result, null, 2));
      continue;
    }

    console.log('✅ EDIT Success');
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  console.error('❌ Test failed');
  console.error(err);
});
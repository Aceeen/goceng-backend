import { applyUserCorrection } from '../src/modules/ai/ai.service';
import { isAIError } from '../src/modules/ai/ai.types';

async function main() {
  const correction = 'harganya jadi 55000, kategorinya tetap BBM';

  const currentData = {
    type: 'EXPENSE',
    amount: 50000,
    description: 'bensin',
    merchantName: 'SPBU',
    transactionDate: '2026-04-22',
    suggestedCategory: 'BBM',
  };

  const result = await applyUserCorrection(correction, currentData);

  if (isAIError(result)) {
    console.log('❌ AI Error');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('✅ EDIT Success');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('❌ Test failed');
  console.error(err);
});
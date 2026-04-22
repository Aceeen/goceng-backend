import { extractFromText } from '../src/modules/ai/ai.service';
import { isAIError } from '../src/modules/ai/ai.types';

async function main() {
  const categories = [
    'Makan & Minum',
    'BBM',
    'Belanja',
    'Transportasi',
    'Gaji',
    'Kesehatan',
    'Hiburan',
    'Lainnya',
  ];

  const samples = [
    'makan siang di warteg 15rb',
    'bensin 50rb',
    'gajian 2500000',
    'bayar grab 22 ribu',
    'beli obat 35rb',
    'tadi habis makan',
  ];

  for (const message of samples) {
    console.log('\n==============================');
    console.log('INPUT:', message);

    const result = await extractFromText(message, categories);

    if (isAIError(result)) {
      console.log('❌ AI Error');
      console.log(JSON.stringify(result, null, 2));
      continue;
    }

    console.log('✅ NLP Success');
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  console.error('❌ Test failed');
  console.error(err);
});
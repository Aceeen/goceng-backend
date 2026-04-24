import fs from 'fs';
import path from 'path';
// import { extractFromImage, getAIProviderNames } from '../src/modules/ai/ai.service';
import { extractFromImage, getOCRProviders } from '../src/modules/ai/ai.service';
import { isAIError } from '../src/modules/ai/ai.types';

async function main() {
  const imagePath = path.resolve('scripts/notaluarnegeri.jpg');

  if (!fs.existsSync(imagePath)) {
    console.error('❌ File gambar tidak ditemukan:', imagePath);
    return;
  }

  const base64Image = fs.readFileSync(imagePath).toString('base64');

  const result = await extractFromImage(base64Image, 'image/jpeg');

  if (isAIError(result)) {
    console.log('❌ AI Error');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('✅ OCR Success');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('❌ Test failed');
  console.error(err);
});
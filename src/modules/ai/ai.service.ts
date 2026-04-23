// src/modules/ai/ai.service.ts

import { GoogleGenerativeAI, GenerativeModel, HarmCategory, HarmBlockThreshold, Part } from '@google/generative-ai';
import { env } from '../../config/env';
import { OCR_PROMPT, buildNLPPrompt, buildEditPrompt } from './ai.prompts';
import {
  OCRResponse, NLPResponse, EditResponse,
  isOCRBlur, isOCRForeign, isOCRNormal,
} from './ai.types';

let geminiModel: GenerativeModel | null = null;

function getGeminiModel(): GenerativeModel {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_NOT_CONFIGURED');
  }

  if (!geminiModel) {
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      ],
    });
  }

  return geminiModel;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 9000];

async function callGeminiWithRetry(parts: Part[], retries = 0): Promise<string> {
  try {
    const result = await getGeminiModel().generateContent(parts);
    return result.response.text().trim();
  } catch (error) {
    if (error instanceof Error && error.message === 'GEMINI_NOT_CONFIGURED') {
      throw error;
    }

    if (retries >= MAX_RETRIES) {
      console.error('[AI] Gemini max retry exceeded:', error);
      throw new Error('GEMINI_MAX_RETRY_EXCEEDED');
    }

    console.warn(`[AI] Gemini retry ${retries + 1}/${MAX_RETRIES}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[retries]));
    return callGeminiWithRetry(parts, retries + 1);
  }
}

function parseGeminiJSON<T>(raw: string): T {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  return JSON.parse(cleaned) as T;
}

function buildMissingConfigResponse() {
  return {
    error: 'PARSE_ERROR' as const,
    message: 'Fitur AI belum dikonfigurasi.',
  };
}

export async function extractFromImage(
  base64Image: string,
  mimeType: string = 'image/jpeg'
): Promise<OCRResponse> {
  try {
    const raw = await callGeminiWithRetry([
      { text: OCR_PROMPT },
      { inlineData: { data: base64Image, mimeType } },
    ]);
    const parsed = parseGeminiJSON<OCRResponse>(raw);

    if ('case' in parsed) {
      if (isOCRBlur(parsed)) {
        console.log('[AI] OCR case: BLUR -', parsed.message);
      } else if (isOCRForeign(parsed)) {
        console.log(`[AI] OCR case: FOREIGN - ${parsed.originalCurrency} ${parsed.originalAmount} -> IDR ${parsed.totalAmount}`);
      } else if (isOCRNormal(parsed)) {
        console.log(`[AI] OCR case: NORMAL - ${parsed.merchantName} Rp${parsed.totalAmount}`);
      }
    }

    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === 'GEMINI_NOT_CONFIGURED') {
      return buildMissingConfigResponse();
    }
    if (error instanceof Error && error.message === 'GEMINI_MAX_RETRY_EXCEEDED') {
      return { error: 'GEMINI_MAX_RETRY_EXCEEDED', message: 'Layanan AI sedang sibuk, coba lagi nanti.' };
    }
    console.error('[AI] OCR error:', error);
    return { error: 'PARSE_ERROR', message: 'Gagal memproses gambar struk.' };
  }
}

export async function extractFromText(
  message: string,
  categories: string[]
): Promise<NLPResponse> {
  try {
    const raw = await callGeminiWithRetry([{ text: buildNLPPrompt(message, categories) }]);
    const parsed = parseGeminiJSON<NLPResponse>(raw);
    console.log('[AI] NLP success:', (parsed as any).amount, (parsed as any).suggestedCategory);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === 'GEMINI_NOT_CONFIGURED') {
      return buildMissingConfigResponse();
    }
    if (error instanceof Error && error.message === 'GEMINI_MAX_RETRY_EXCEEDED') {
      return { error: 'GEMINI_MAX_RETRY_EXCEEDED', message: 'Layanan AI sedang sibuk, coba lagi nanti.' };
    }
    console.error('[AI] NLP error:', error);
    return { error: 'PARSE_ERROR', message: 'Gagal memproses pesan teks.' };
  }
}

export async function applyUserCorrection(
  correction: string,
  currentData: object
): Promise<EditResponse> {
  try {
    const raw = await callGeminiWithRetry([{ text: buildEditPrompt(correction, currentData) }]);
    const parsed = parseGeminiJSON<EditResponse>(raw);
    console.log('[AI] Edit applied:', correction);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === 'GEMINI_NOT_CONFIGURED') {
      return buildMissingConfigResponse();
    }
    if (error instanceof Error && error.message === 'GEMINI_MAX_RETRY_EXCEEDED') {
      return { error: 'GEMINI_MAX_RETRY_EXCEEDED', message: 'Layanan AI sedang sibuk, coba lagi nanti.' };
    }
    console.error('[AI] Edit error:', error);
    return { error: 'PARSE_ERROR', message: 'Gagal memproses koreksi.' };
  }
}

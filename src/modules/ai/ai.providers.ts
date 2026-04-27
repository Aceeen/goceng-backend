// src/modules/ai/ai.providers.ts
import 'dotenv/config';
import {
  GoogleGenerativeAI,
  GenerativeModel,
  Part,
} from '@google/generative-ai';


const MAX_RETRIES = Math.max(0, Number(process.env.AI_MAX_RETRIES ?? 2));
const BASE_DELAY_MS = Math.max(
  250,
  Number(process.env.AI_RETRY_BASE_DELAY_MS ?? 1500)
);

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const geminiModelCache = new Map<string, GenerativeModel>();

function getGeminiOCRPrimaryModelName(): string {
  return process.env.GEMINI_OCR_PRIMARY_MODEL?.trim() || 'gemini-2.5-flash-lite';
}

function getGeminiModel(modelName: string): GenerativeModel {
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error('GEMINI_NOT_CONFIGURED');
  }

  if (!geminiModelCache.has(modelName)) {
    const genAI = new GoogleGenerativeAI(apiKey);

    geminiModelCache.set(
      modelName,
      genAI.getGenerativeModel({
        model: modelName,
      })
    );
  }

  return geminiModelCache.get(modelName)!;
}

async function callGeminiOCROnce(
  parts: Part[],
  modelName: string
): Promise<string> {
  const result = await getGeminiModel(modelName).generateContent(parts);
  const text = result.response.text().trim();

  if (!text) {
    throw new Error('GEMINI_EMPTY_RESPONSE');
  }

  return text;
}

export async function callGeminiOCRPrimary(
  parts: Part[]
): Promise<{ text: string; provider: string; model: string }> {
  const modelName = getGeminiOCRPrimaryModelName();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(
        `[AI] Trying Gemini OCR model ${modelName}, attempt ${attempt + 1}/${MAX_RETRIES + 1}`
      );

      const text = await callGeminiOCROnce(parts, modelName);

      console.log(`[AI] Success with Gemini OCR model ${modelName}`);

      return {
        text,
        provider: 'gemini',
        model: modelName,
      };
    } catch (error) {
      const info = inspectError(error);

      console.warn(`[AI] Failed with Gemini OCR model ${modelName}`, {
        attempt: attempt + 1,
        statusCode: info.statusCode,
        message: info.message,
      });

      if (!info.retryable) {
        throw error;
      }

      const hasNextRetry = attempt < MAX_RETRIES;
      if (hasNextRetry) {
        const delayMs = getDelayMs(attempt);
        console.warn(`[AI] Retry Gemini OCR model ${modelName} in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }

      throw new Error('GEMINI_MAX_RETRY_EXCEEDED');
    }
  }

  throw new Error('GEMINI_REQUEST_FAILED');
}

class ProviderHttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(`[${statusCode}] ${message}`);
    this.name = 'ProviderHttpError';
    this.statusCode = statusCode;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDelayMs(attempt: number) {
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 500);
  return exponential + jitter;
}

function uniq(values: string[]) {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function extractStatusCodeFromMessage(message: string): number | undefined {
  const match = message.match(/\[(\d{3})\]/);
  return match ? Number(match[1]) : undefined;
}

function inspectError(error: unknown): {
  statusCode?: number;
  message: string;
  retryable: boolean;
} {
  let statusCode: number | undefined;
  let message = 'Unknown error';

  if (error instanceof ProviderHttpError) {
    statusCode = error.statusCode;
    message = error.message;
  } else if (error instanceof Error) {
    message = error.message;
    statusCode = extractStatusCodeFromMessage(message);
  }

  const retryableByStatus = statusCode
    ? RETRYABLE_STATUS_CODES.has(statusCode)
    : false;

  const retryableByMessage =
    /service unavailable|high demand|temporarily unavailable|timeout|timed out|econnreset|socket hang up|rate limit/i.test(
      message
    );

  return {
    statusCode,
    message,
    retryable: retryableByStatus || retryableByMessage,
  };
}

function safeJsonParse<T = any>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function extractErrorMessageFromBody(raw: string): string {
  const parsed = safeJsonParse<any>(raw);

  if (!parsed) {
    return raw || 'Unknown provider error';
  }

  if (typeof parsed.error === 'string') {
    return parsed.error;
  }

  if (typeof parsed.error?.message === 'string') {
    return parsed.error.message;
  }

  if (typeof parsed.message === 'string') {
    return parsed.message;
  }

  return raw || 'Unknown provider error';
}

function getGroqModelOrder(): string[] {
  return uniq([
    process.env.GROQ_PRIMARY_MODEL || 'llama-3.1-8b-instant',
    process.env.GROQ_FALLBACK_MODEL_1 || 'qwen/qwen3-32b',
    process.env.GROQ_FALLBACK_MODEL_2 || 'llama-3.3-70b-versatile',
  ]);
}

export function getGroqFallbackChain(): string[] {
  return getGroqModelOrder();
}

export function getOCRProviderName(): string {
  return `gemini/${getGeminiOCRPrimaryModelName()}`;
}

export function getOCRProviderNames(): string[] {
  return [
    `gemini/${getGeminiOCRPrimaryModelName()}`,
    'ocr.space',
  ];
}

export function getNLPProviderNames(): string[] {
  return getGroqModelOrder().map((model) => `groq/${model}`);
}

export function getEditProviderNames(): string[] {
  return getGroqModelOrder().map((model) => `groq/${model}`);
}

async function callOCRSpaceOnce(
  base64Image: string,
  mimeType: string = 'image/jpeg'
): Promise<string> {
  const apiKey = process.env.OCR_SPACE_API_KEY?.trim();

  if (!apiKey) {
    throw new Error('OCR_SPACE_NOT_CONFIGURED');
  }

  const body = new URLSearchParams();
  body.set('base64Image', `data:${mimeType};base64,${base64Image}`);
  body.set('language', process.env.OCR_SPACE_LANGUAGE?.trim() || 'auto');
  body.set('isTable', 'true');
  body.set('scale', 'true');
  body.set('OCREngine', process.env.OCR_SPACE_ENGINE?.trim() || '2');

  const response = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new ProviderHttpError(
      response.status,
      extractErrorMessageFromBody(raw) || 'OCR.space request failed'
    );
  }

  const payload = safeJsonParse<any>(raw);

  if (!payload) {
    throw new Error('OCR_SPACE_INVALID_JSON');
  }

  if (payload.IsErroredOnProcessing) {
    const errorMessage = Array.isArray(payload.ErrorMessage)
      ? payload.ErrorMessage.join(' | ')
      : payload.ErrorMessage || 'OCR.space processing failed';

    throw new Error(`OCR_SPACE_PROCESSING_FAILED: ${errorMessage}`);
  }

  const parsedText = Array.isArray(payload.ParsedResults)
    ? payload.ParsedResults
        .map((item: any) => String(item?.ParsedText || '').trim())
        .filter(Boolean)
        .join('\n')
        .trim()
    : '';

  // kalau kosong, tetap kembalikan placeholder agar model NLP/Edit bisa menilai ini sebagai blur / unreadable
  return parsedText || '[NO_TEXT_DETECTED_FROM_OCR]';
}

export async function callOCRSpace(
  base64Image: string,
  mimeType: string = 'image/jpeg'
): Promise<{ text: string; provider: string }> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(
        `[AI] Trying OCR provider ocr.space, attempt ${attempt + 1}/${MAX_RETRIES + 1}`
      );

      const text = await callOCRSpaceOnce(base64Image, mimeType);

      console.log('[AI] Success with OCR provider ocr.space');

      return {
        text,
        provider: 'ocr.space',
      };
    } catch (error) {
      const info = inspectError(error);

      console.warn('[AI] Failed with OCR provider ocr.space', {
        attempt: attempt + 1,
        statusCode: info.statusCode,
        message: info.message,
      });

      if (!info.retryable) {
        throw error;
      }

      const hasNextRetry = attempt < MAX_RETRIES;
      if (hasNextRetry) {
        const delayMs = getDelayMs(attempt);
        console.warn(`[AI] Retry ocr.space in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }

      throw new Error('OCR_SPACE_MAX_RETRY_EXCEEDED');
    }
  }

  throw new Error('OCR_SPACE_REQUEST_FAILED');
}

async function callGroqOnce(
  prompt: string,
  modelName: string
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY?.trim();

  if (!apiKey) {
    throw new Error('GROQ_NOT_CONFIGURED');
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelName,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new ProviderHttpError(
      response.status,
      extractErrorMessageFromBody(raw) || 'Groq request failed'
    );
  }

  const payload = safeJsonParse<any>(raw);

  if (!payload) {
    throw new Error('GROQ_INVALID_JSON');
  }

  const text = String(payload?.choices?.[0]?.message?.content || '').trim();

  if (!text) {
    throw new Error('GROQ_EMPTY_RESPONSE');
  }

  return text;
}

export async function callGroqWithFallback(
  prompt: string
): Promise<{ text: string; model: string; provider: string }> {
  const models = getGroqModelOrder();

  if (!models.length) {
    throw new Error('GROQ_NOT_CONFIGURED');
  }

  let sawRetryableFailure = false;
  let sawAnyFailure = false;
  let lastError: unknown = null;

  for (const modelName of models) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(
          `[AI] Trying Groq model ${modelName}, attempt ${attempt + 1}/${MAX_RETRIES + 1}`
        );

        const text = await callGroqOnce(prompt, modelName);

        console.log(`[AI] Success with Groq model ${modelName}`);

        return {
          text,
          model: modelName,
          provider: 'groq',
        };
      } catch (error) {
        const info = inspectError(error);
        sawAnyFailure = true;
        lastError = error;

        console.warn(`[AI] Failed with Groq model ${modelName}`, {
          attempt: attempt + 1,
          statusCode: info.statusCode,
          message: info.message,
        });

        if (!info.retryable) {
          console.warn(
            `[AI] Non-retryable failure on Groq model ${modelName}, switching to next model...`
          );
          break;
        }

        sawRetryableFailure = true;

        const hasNextRetry = attempt < MAX_RETRIES;
        if (hasNextRetry) {
          const delayMs = getDelayMs(attempt);
          console.warn(`[AI] Retry Groq model ${modelName} in ${delayMs}ms`);
          await sleep(delayMs);
          continue;
        }

        console.warn(`[AI] Groq model exhausted: ${modelName}, switching...`);
        break;
      }
    }
  }

  if (sawRetryableFailure) {
    throw new Error('GROQ_MAX_RETRY_EXCEEDED');
  }

  if (
    sawAnyFailure &&
    lastError instanceof Error &&
    lastError.message === 'GROQ_NOT_CONFIGURED'
  ) {
    throw lastError;
  }

  if (sawAnyFailure) {
    throw new Error('GROQ_REQUEST_FAILED');
  }

  throw new Error('GROQ_REQUEST_FAILED');
}

/*
  COMPATIBILITY BRIDGE
  ------------------------------------------------------------
  Export lama tetap disediakan sementara agar file ai.service.ts
  lama tidak langsung pecah saat transisi dari Gemini ke OCR.space + Groq.

  Alurnya:
  - kalau parts berisi gambar -> OCR.space baca teks mentah -> Groq ubah ke JSON sesuai prompt
  - kalau parts hanya teks -> Groq langsung proses prompt
*/

function buildOCRBridgePrompt(promptText: string, ocrText: string): string {
  return [
    promptText,
    '',
    'Berikut adalah hasil OCR mentah dari gambar/struk.',
    'Gunakan hanya teks OCR ini sebagai sumber data utama.',
    'Jika teks OCR kosong atau sangat buruk, pertimbangkan case BLUR.',
    '',
    'OCR_TEXT_START',
    ocrText,
    'OCR_TEXT_END',
  ].join('\n');
}

function extractPromptText(parts: Part[]): string {
  return parts
    .map((part) => {
      if ('text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractInlineImage(parts: Part[]): { data: string; mimeType: string } | null {
  for (const part of parts) {
    if (
      'inlineData' in part &&
      part.inlineData &&
      typeof part.inlineData.data === 'string'
    ) {
      return {
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType || 'image/jpeg',
      };
    }
  }

  return null;
}

// export function getGeminiFallbackChain(): string[] {
//   return getModelOrder();
// }

// export function getGeminiFallbackChain(): string[] {
//   return [
//     `${getOCRProviderName()} -> ${getGroqModelOrder().join(' -> ')}`,
//   ];
// }

// export async function callGeminiWithFallback(
//   parts: Part[]
// ): Promise<{ text: string; model: string }> {
//   const promptText = extractPromptText(parts);
//   const image = extractInlineImage(parts);

//   if (image) {
//     const ocrResult = await callOCRSpace(image.data, image.mimeType);

//     const bridgedPrompt = [
//       promptText,
//       '',
//       'Berikut adalah hasil OCR mentah dari gambar/struk.',
//       'Gunakan hanya teks OCR ini sebagai sumber data utama.',
//       'Jika teks OCR kosong atau sangat buruk, pertimbangkan case BLUR.',
//       '',
//       'OCR_TEXT_START',
//       ocrResult.text,
//       'OCR_TEXT_END',
//     ].join('\n');

//     const groqResult = await callGroqWithFallback(bridgedPrompt);

//     return {
//       text: groqResult.text,
//       model: `${ocrResult.provider} + groq/${groqResult.model}`,
//     };
//   }

//   const groqResult = await callGroqWithFallback(promptText);

//   return {
//     text: groqResult.text,
//     model: `groq/${groqResult.model}`,
//   };
// }

export function getGeminiFallbackChain(): string[] {
  return [
    `gemini/${getGeminiOCRPrimaryModelName()}`,
    'ocr.space',
    ...getGroqModelOrder().map((model) => `groq/${model}`),
  ];
}

export async function callGeminiWithFallback(
  parts: Part[]
): Promise<{ text: string; model: string }> {
  const promptText = extractPromptText(parts);
  const image = extractInlineImage(parts);

  if (image) {
    try {
      const geminiResult = await callGeminiOCRPrimary(parts);

      return {
        text: geminiResult.text,
        model: `gemini/${geminiResult.model}`,
      };
    } catch (error) {
      const info = inspectError(error);

      console.warn('[AI] Gemini OCR primary failed, switching to OCR.space fallback', {
        statusCode: info.statusCode,
        message: info.message,
      });

      const ocrResult = await callOCRSpace(image.data, image.mimeType);
      const bridgedPrompt = buildOCRBridgePrompt(promptText, ocrResult.text);
      const groqResult = await callGroqWithFallback(bridgedPrompt);

      return {
        text: groqResult.text,
        model: `${ocrResult.provider} + groq/${groqResult.model}`,
      };
    }
  }

  const groqResult = await callGroqWithFallback(promptText);

  return {
    text: groqResult.text,
    model: `groq/${groqResult.model}`,
  };
}
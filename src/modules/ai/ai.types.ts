// src/modules/ai/ai.types.ts

// ─── Item dalam struk ─────────────────────────────────────────────────────────

export interface OCRTransactionItem {
  name: string;
  quantity: number;
  unitPrice: number;   // dalam IDR (sudah dikonversi jika nota luar negeri)
  totalPrice: number;  // dalam IDR
}

// ─── Case 1: Nota blur / tidak terbaca ───────────────────────────────────────

export interface OCRBlurResult {
  case: 'BLUR';
  message: string;  // pesan ramah untuk dikirim ke user
}

// ─── Case 2: Nota normal (dalam negeri, IDR) ─────────────────────────────────

export interface OCRNormalResult {
  case: 'NORMAL';
  merchantName: string;
  transactionDate: string;     // YYYY-MM-DD
  totalAmount: number;         // dalam IDR
  items: OCRTransactionItem[];
  suggestedCategory: string;
  confidence: number;          // 0.0 – 1.0
}

// ─── Case 3: Nota luar negeri (mata uang asing) ───────────────────────────────

export interface OCRForeignResult {
  case: 'FOREIGN';
  merchantName: string;
  transactionDate: string;       // YYYY-MM-DD
  originalCurrency: string;      // kode mata uang, contoh: "USD", "MYR", "SGD"
  originalAmount: number;        // total dalam mata uang asli
  exchangeRate: number;          // kurs yang dipakai (IDR per 1 unit mata uang asing)
  totalAmount: number;           // hasil konversi ke IDR
  items: OCRTransactionItem[];
  suggestedCategory: string;
  confidence: number;
}

// ─── Union type hasil OCR ─────────────────────────────────────────────────────

export type OCRResult = OCRNormalResult | OCRForeignResult | OCRBlurResult;

// ─── Hasil NLP dari teks kasual ───────────────────────────────────────────────

export interface NLPResult {
  type: 'INCOME' | 'EXPENSE';
  amount: number;
  description: string;
  transactionDate: string;    // YYYY-MM-DD
  suggestedCategory: string;
  confidence: number;
}

// ─── Hasil EDIT dari koreksi user ────────────────────────────────────────────

export interface EditResult {
  type?: 'INCOME' | 'EXPENSE';
  amount?: number;
  description?: string;
  merchantName?: string;
  transactionDate?: string;
  suggestedCategory?: string;
}

// ─── Error response dari AI ───────────────────────────────────────────────────

// export interface AIErrorResult {
//   error: 'NO_AMOUNT' | 'PARSE_ERROR' | 'GEMINI_MAX_RETRY_EXCEEDED';
//   message: string;
// }

// export interface AIErrorResult {
//   error:
//     | 'NO_AMOUNT'
//     | 'PARSE_ERROR'
//     | 'GEMINI_MAX_RETRY_EXCEEDED'
//     | 'AI_NOT_CONFIGURED'
//     | 'AI_ALL_PROVIDERS_FAILED'
//     | 'AI_UPSTREAM_NON_RETRYABLE';
//   message: string;
// }

export interface AIErrorResult {
  error:
    | 'NO_AMOUNT'
    | 'PARSE_ERROR'
    | 'AI_NOT_CONFIGURED'
    | 'AI_MAX_RETRY_EXCEEDED'
    | 'AI_REQUEST_FAILED';
  message: string;
}

// ─── Union types untuk return value service ───────────────────────────────────

export type OCRResponse  = OCRResult  | AIErrorResult;
export type NLPResponse  = NLPResult  | AIErrorResult;
export type EditResponse = EditResult | AIErrorResult;

// ─── Type guards ──────────────────────────────────────────────────────────────

export function isAIError(result: unknown): result is AIErrorResult {
  return typeof result === 'object' && result !== null && 'error' in result;
}

export function isOCRBlur(result: OCRResult): result is OCRBlurResult {
  return result.case === 'BLUR';
}

export function isOCRForeign(result: OCRResult): result is OCRForeignResult {
  return result.case === 'FOREIGN';
}

export function isOCRNormal(result: OCRResult): result is OCRNormalResult {
  return result.case === 'NORMAL';
}
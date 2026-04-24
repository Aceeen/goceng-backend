// src/modules/ai/ai.validators.ts

import {
  EditResponse,
  AIErrorResult,
  isAIError,
  NLPResponse,
  OCRResponse,
} from './ai.types';

function buildValidationError(message: string): AIErrorResult {
  return {
    error: 'PARSE_ERROR',
    message,
  };
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizePositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.-]/g, '');
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function normalizeQuantity(value: unknown): number | null {
  const num = normalizePositiveNumber(value);
  if (num == null) return null;
  return Math.max(1, Math.round(num));
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }

  return 0.5;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }

  const date = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return trimmed;
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeItems(items: unknown): Array<{
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}> {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => {
      if (!item || typeof item !== 'object') return null;

      const obj = item as Record<string, unknown>;

      const name = normalizeString(obj.name);
      const quantity = normalizeQuantity(obj.quantity);
      const unitPrice = normalizePositiveNumber(obj.unitPrice);
      const totalPrice = normalizePositiveNumber(obj.totalPrice);

      if (!name || quantity == null || unitPrice == null || totalPrice == null) {
        return null;
      }

      return {
        name,
        quantity,
        unitPrice,
        totalPrice,
      };
    })
    .filter(Boolean) as Array<{
      name: string;
      quantity: number;
      unitPrice: number;
      totalPrice: number;
    }>;
}

export function validateOCRResponse(input: OCRResponse): OCRResponse {
  if (isAIError(input)) {
    return input;
  }

  if (!input || typeof input !== 'object' || !('case' in input)) {
    return buildValidationError('Hasil OCR AI tidak valid.');
  }

  if (input.case === 'BLUR') {
    const message = normalizeString(input.message);
    if (!message) {
      return buildValidationError('Pesan BLUR dari AI tidak valid.');
    }

    return {
      case: 'BLUR',
      message,
    };
  }

  if (input.case === 'NORMAL') {
    const merchantName = normalizeString(input.merchantName) || 'UNKNOWN_MERCHANT';
    const transactionDate = normalizeDate(input.transactionDate);
    const totalAmount = normalizePositiveNumber(input.totalAmount);
    const suggestedCategory =
      normalizeString(input.suggestedCategory) || 'Pengeluaran Lainnya';
    const confidence = normalizeConfidence(input.confidence);
    const items = normalizeItems(input.items);

    if (!transactionDate || totalAmount == null) {
      return buildValidationError('Hasil OCR NORMAL tidak valid.');
    }

    return {
      case: 'NORMAL',
      merchantName,
      transactionDate,
      totalAmount,
      items,
      suggestedCategory,
      confidence,
    };
  }

  if (input.case === 'FOREIGN') {
    const merchantName = normalizeString(input.merchantName) || 'UNKNOWN_MERCHANT';
    const transactionDate = normalizeDate(input.transactionDate);
    const originalCurrency = normalizeCurrency(input.originalCurrency);
    const originalAmount = normalizePositiveNumber(input.originalAmount);
    const exchangeRate = normalizePositiveNumber(input.exchangeRate);
    const totalAmount = normalizePositiveNumber(input.totalAmount);
    const suggestedCategory =
      normalizeString(input.suggestedCategory) || 'Pengeluaran Lainnya';
    const confidence = normalizeConfidence(input.confidence);
    const items = normalizeItems(input.items);

    if (
      !transactionDate ||
      !originalCurrency ||
      originalAmount == null ||
      exchangeRate == null ||
      totalAmount == null
    ) {
      return buildValidationError('Hasil OCR FOREIGN tidak valid.');
    }

    return {
      case: 'FOREIGN',
      merchantName,
      transactionDate,
      originalCurrency,
      originalAmount,
      exchangeRate,
      totalAmount,
      items,
      suggestedCategory,
      confidence,
    };
  }

  return buildValidationError('Case OCR tidak dikenali.');
}

export function validateNLPResponse(input: NLPResponse): NLPResponse {
  if (isAIError(input)) {
    return input;
  }

  const allowedTypes = new Set(['INCOME', 'EXPENSE']);

  const type = normalizeString(input.type);
  const amount = normalizePositiveNumber(input.amount);
  const description = normalizeString(input.description);
  const transactionDate = normalizeDate(input.transactionDate);
  const suggestedCategory =
    normalizeString(input.suggestedCategory) || 'Pengeluaran Lainnya';
  const confidence = normalizeConfidence(input.confidence);

  if (
    !type ||
    !allowedTypes.has(type) ||
    amount == null ||
    !description ||
    !transactionDate
  ) {
    return buildValidationError('Hasil NLP AI tidak valid.');
  }

  return {
    type: type as 'INCOME' | 'EXPENSE',
    amount,
    description,
    transactionDate,
    suggestedCategory,
    confidence,
  };
}

export function validateEditResponse(input: EditResponse): EditResponse {
  if (isAIError(input)) {
    return input;
  }

  const result: Record<string, unknown> = {};

  const type = normalizeString(input.type);
  if (type === 'INCOME' || type === 'EXPENSE') {
    result.type = type;
  }

  const amount = normalizePositiveNumber(input.amount);
  if (amount != null) {
    result.amount = amount;
  }

  const description = normalizeString(input.description);
  if (description) {
    result.description = description;
  }

  const merchantName = normalizeString(input.merchantName);
  if (merchantName) {
    result.merchantName = merchantName;
  }

  const transactionDate = normalizeDate(input.transactionDate);
  if (transactionDate) {
    result.transactionDate = transactionDate;
  }

  const suggestedCategory = normalizeString(input.suggestedCategory);
  if (suggestedCategory) {
    result.suggestedCategory = suggestedCategory;
  }

  if (!Object.keys(result).length) {
    return buildValidationError('Hasil edit AI kosong atau tidak valid.');
  }

  return result as EditResponse;
}
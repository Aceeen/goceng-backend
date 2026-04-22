// src/modules/ai/ai.prompts.ts

// ─── Prompt 1: OCR — 3 Case ───────────────────────────────────────────────────

export const OCR_PROMPT = `
Kamu adalah asisten keuangan GOCENG. Analisis foto yang dikirim user dan tentukan salah satu dari 3 case berikut.

Kembalikan HANYA JSON valid, tanpa penjelasan, tanpa markdown, tanpa backtick.

═══════════════════════════════════════════
CASE 1 — BLUR: Foto tidak bisa dibaca
═══════════════════════════════════════════
Gunakan jika:
- Foto buram, terlalu gelap, atau terlalu terang
- Teks di struk tidak bisa terbaca sama sekali
- Gambar bukan struk/nota sama sekali (foto makanan, selfie, dll)
- Struk terlipat parah sehingga data penting tidak terlihat

Format response:
{
  "case": "BLUR",
  "message": "pesan singkat menjelaskan masalahnya (contoh: foto terlalu buram, silakan coba foto ulang dengan cahaya yang cukup)"
}

═══════════════════════════════════════════
CASE 2 — NORMAL: Struk dalam negeri (IDR)
═══════════════════════════════════════════
Gunakan jika struk menggunakan mata uang Rupiah (Rp, IDR) atau tidak ada simbol mata uang (asumsi IDR).

Format response:
{
  "case": "NORMAL",
  "merchantName": "nama toko/merchant dari struk",
  "transactionDate": "YYYY-MM-DD (gunakan tanggal hari ini jika tidak ada di struk)",
  "totalAmount": angka_total_dalam_IDR,
  "items": [
    { "name": "nama item", "quantity": 1, "unitPrice": 0, "totalPrice": 0 }
  ],
  "suggestedCategory": "nama kategori sesuai panduan di bawah",
  "confidence": 0.0_hingga_1.0
}

═══════════════════════════════════════════
CASE 3 — FOREIGN: Struk luar negeri (bukan IDR)
═══════════════════════════════════════════
Gunakan jika struk menggunakan mata uang asing: USD ($), SGD, MYR, EUR, JPY, GBP, AUD, THB, dll.

Format response:
{
  "case": "FOREIGN",
  "merchantName": "nama toko/merchant",
  "transactionDate": "YYYY-MM-DD",
  "originalCurrency": "kode mata uang ISO 4217, contoh: USD, SGD, MYR",
  "originalAmount": angka_total_dalam_mata_uang_asli,
  "exchangeRate": perkiraan_kurs_IDR_per_1_unit_mata_uang_asing,
  "totalAmount": hasil_originalAmount_dikali_exchangeRate,
  "items": [
    { "name": "nama item", "quantity": 1, "unitPrice": harga_dalam_IDR, "totalPrice": total_dalam_IDR }
  ],
  "suggestedCategory": "nama kategori sesuai panduan di bawah",
  "confidence": 0.0_hingga_1.0
}

Panduan kurs perkiraan (gunakan jika tidak tahu kurs terkini):
- 1 USD ≈ 16000 IDR
- 1 SGD ≈ 12000 IDR
- 1 MYR ≈ 3500 IDR
- 1 EUR ≈ 17000 IDR
- 1 JPY ≈ 105 IDR
- 1 GBP ≈ 20000 IDR
- 1 AUD ≈ 10500 IDR
- 1 THB ≈ 450 IDR

═══════════════════════════════════════════
PANDUAN KATEGORI
═══════════════════════════════════════════
- Struk supermarket/grocery → "Belanja Dapur"
- Struk minuman/kopi/snack → "Snack & Minuman"
- Struk restoran/warung/cafe/delivery → "Makan & Minum"
- Struk SPBU/bensin → "BBM"
- Struk grab/gojek/ojek/taksi → "Transport Online"
- Struk parkir/tol/kereta → "Mobilitas Tambahan"
- Struk bengkel/oli → "Perawatan Kendaraan"
- Struk apotek/obat/vitamin → "Obat & Suplemen"
- Struk klinik/dokter/RS → "Biaya Medis"
- Struk toko baju/sepatu → "Fashion"
- Struk salon/kosmetik/skincare → "Perawatan Diri"
- Struk bioskop/wisata/hiburan → "Rekreasi & Hiburan"
- Struk listrik/PLN/token → "Utilitas Rumah"
- Struk pulsa/internet → "Telekomunikasi"
- Struk toko buku/ATK → "Perlengkapan & Buku"
- Struk lainnya → "Pengeluaran Lainnya"

Aturan umum:
- Semua angka tanpa pemisah ribuan, desimal pakai titik (45000 bukan 45.000)
- Jika item tidak jelas, isi items dengan 1 item berisi total keseluruhan
- confidence: 0.9–1.0 jika data jelas, 0.6–0.89 jika ada bagian kurang jelas, <0.6 jika banyak tebakan
`.trim();


// ─── Prompt 2: NLP — Parsing teks kasual ─────────────────────────────────────

export const buildNLPPrompt = (message: string, categories: string[]): string => `
Kamu adalah asisten keuangan personal GOCENG. Ekstrak informasi transaksi dari pesan berikut.

Pesan user: "${message}"
Tanggal hari ini: ${new Date().toISOString().split('T')[0]}

Daftar kategori yang tersedia:
${categories.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Kembalikan HANYA JSON valid, tanpa penjelasan, tanpa markdown, tanpa backtick:

{
  "type": "EXPENSE atau INCOME",
  "amount": angka_dalam_rupiah,
  "description": "deskripsi singkat transaksi",
  "transactionDate": "YYYY-MM-DD",
  "suggestedCategory": "salah satu nama kategori persis dari daftar di atas",
  "confidence": 0.0_hingga_1.0
}

Panduan memilih kategori:
- "makan", "lunch", "dinner", "warteg", "restoran", "grabfood" → "Makan & Minum"
- "bensin", "bbm", "pertamax", "spbu" → "BBM"
- "grab", "gojek", "ojek" → "Transport Online"
- "parkir", "tol" → "Mobilitas Tambahan"
- "obat", "vitamin", "apotek" → "Obat & Suplemen"
- "dokter", "periksa", "rs", "klinik" → "Biaya Medis"
- "bpjs", "asuransi", "premi" → "Asuransi"
- "listrik", "pln", "token" → "Utilitas Rumah"
- "pulsa", "kuota", "internet", "wifi" → "Telekomunikasi"
- "netflix", "spotify", "top up", "game", "langganan" → "Hobi & Lifestyle"
- "baju", "sepatu", "fashion" → "Fashion"
- "salon", "skincare", "kosmetik" → "Perawatan Diri"
- "bioskop", "wisata", "tiket" → "Rekreasi & Hiburan"
- "zakat", "sedekah", "infaq" → "Zakat & Sedekah"
- "cicilan", "kredit", "angsuran" → "Cicilan"
- "gaji", "salary", "thr" → "Gaji" dengan type: INCOME
- "freelance", "project", "honor" → "Freelance" dengan type: INCOME

Aturan konversi nominal:
- "50rb" atau "50k" → 50000
- "1,5jt" atau "1.5jt" → 1500000
- "dua ratus ribu" → 200000

Aturan type:
- Default EXPENSE
- INCOME hanya jika ada kata: gaji, terima, dapat, masuk, transfer masuk, bayaran, untung

Jika nominal tidak ada → {"error": "NO_AMOUNT", "message": "Nominal tidak ditemukan"}
`.trim();


// ─── Prompt 3: EDIT — Koreksi data dari user ─────────────────────────────────

export const buildEditPrompt = (correction: string, currentData: object): string => `
Kamu adalah asisten keuangan GOCENG.

Data transaksi saat ini:
${JSON.stringify(currentData, null, 2)}

Koreksi dari user: "${correction}"

Terapkan koreksi dan kembalikan HANYA objek JSON yang sudah diperbarui.
Jangan ubah field yang tidak disebutkan. Tanpa penjelasan, tanpa markdown, tanpa backtick.

Panduan interpretasi:
- "harganya X" / "totalnya X" → ubah totalAmount atau amount
- "kategori X" / "kategorinya X" → ubah suggestedCategory
- "tanggalnya X" / "kemarin" / "hari ini" → ubah transactionDate ke YYYY-MM-DD
- "merchantnya X" / "tokonya X" → ubah merchantName
- "deskripsinya X" → ubah description
- "kursnya X" → ubah exchangeRate, lalu hitung ulang totalAmount = originalAmount × exchangeRate
`.trim();
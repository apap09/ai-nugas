// Logika generate soal untuk Worker Cloudflare.
// Isi dasarnya sama dengan api/index.js di Vercel, bedanya:
//  - API key dibaca dari env (Cloudflare secrets), bukan process.env
//  - tidak ada batas 60 detik; timeout per panggilan AI diatur di bawah
//  - ada callback onProgress supaya browser tahu proses masih jalan
// File ini sengaja tidak meng-import apa pun dari Cloudflare, jadi bisa dites di Node.

// SAMA dengan GEMINI_MODELS / GROQ_MODELS di api/index.js. Kalau salah satu diubah, ubah dua-duanya.
export const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-flash-latest'
];
export const GROQ_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];

export const BATCH_SIZE = 10;
export const MAX_MATERI_CHARS = 25000;
export const MAX_SOAL = 50;

// Timeout per satu panggilan AI (ms). Di Vercel dulu 55000 (Gemini) dan 20000 (Groq).
const GEMINI_TIMEOUT_MS = 150000;
const GROQ_TIMEOUT_MS = 90000;

export function buildPrompt(materi, jumlahSoal) {
  return 'Kamu adalah AI pembuat soal ujian yang AKURAT dan TELITI.\n\n' +
    'TUGAS: Analisis materi berikut, lalu hasilkan soal kuis pilihan ganda.\n\n' +
    'ATURAN ANALISIS:\n' +
    '1. JIKA file berisi SOAL + PILIHAN GANDA + JAWABAN:\n' +
    '   -> Ekstrak PERSIS seperti di file\n' +
    '   -> Jumlah opsi jawaban IKUTI file\n' +
    '   -> WAJIB: Sertakan field "penjelasan" (1 kalimat singkat)\n\n' +
    '2. JIKA file berisi SOAL saja:\n' +
    '   -> Buatkan pilihan ganda A-E sendiri\n' +
    '   -> WAJIB: Sertakan field "penjelasan" (1 kalimat)\n\n' +
    '3. JIKA file berisi MATERI saja:\n' +
    '   -> Buatkan TEPAT ' + jumlahSoal + ' SOAL. Tidak kurang, tidak lebih.\n' +
    '   -> Setiap soal WAJIB punya field "penjelasan" (1 kalimat singkat)\n\n' +
    'FORMAT OUTPUT (HANYA JSON, tanpa markdown):\n' +
    '{\n' +
    '  "mode": "ekstrak" | "buat_soal" | "buat_dari_materi",\n' +
    '  "jumlah_opsi": 4 atau 5,\n' +
    '  "judul": "Judul singkat kuis",\n' +
    '  "soal": [\n' +
    '    {\n' +
    '      "pertanyaan": "Teks pertanyaan",\n' +
    '      "pilihan": { "A": "...", "B": "...", "C": "...", "D": "...", "E": "..." },\n' +
    '      "jawaban_benar": "B",\n' +
    '      "penjelasan": "Penjelasan singkat 1 kalimat"\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'Jika opsi hanya 4, hilangkan key "E".\n\n' +
    'MATERI:\n"""\n' + materi + '\n"""\n';
}

// signal (opsional) = pembatalan dari luar, mis. saat browser menutup koneksi.
async function fetchWithTimeout(url, options, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

async function callGemini(prompt, model, key, signal) {
  if (!key) throw new Error('NO_KEY');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, responseMimeType: 'application/json', maxOutputTokens: 8192 }
    })
  }, GEMINI_TIMEOUT_MS, signal);

  const rawText = await response.text();
  let data;
  try { data = JSON.parse(rawText); } catch (e) { throw new Error(model + ': non-JSON'); }

  if (!response.ok) {
    throw new Error(model + ': ' + ((data.error && data.error.message) || ('HTTP ' + response.status)));
  }

  const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;
  if (!text) throw new Error(model + ': kosong');
  return text;
}

async function callGroq(prompt, model, key, signal) {
  if (!key) throw new Error('NO_KEY');
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: 'Kamu adalah AI pembuat soal yang hanya membalas JSON valid. WAJIB patuhi jumlah soal PERSIS.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
      max_tokens: 8000
    })
  }, GROQ_TIMEOUT_MS, signal);

  const rawText = await response.text();
  let data;
  try { data = JSON.parse(rawText); } catch (e) { throw new Error(model + ': non-JSON'); }

  if (!response.ok) {
    throw new Error(model + ': ' + ((data.error && data.error.message) || ('HTTP ' + response.status)));
  }

  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error(model + ': kosong');
  return text;
}

// Urutan sama dengan api/index.js: Groq dulu, lalu Gemini. Hanya yang API key-nya ada.
export function getAvailableProviders(env) {
  const list = [];
  const groqKey = (env.GROQ_API_KEY || '').trim();
  const geminiKey = (env.GEMINI_API_KEY || '').trim();

  if (groqKey) {
    GROQ_MODELS.forEach(m => list.push({
      id: m, provider: 'Groq', fn: (prompt, signal) => callGroq(prompt, m, groqKey, signal)
    }));
  }
  if (geminiKey) {
    GEMINI_MODELS.forEach(m => list.push({
      id: m, provider: 'Gemini', fn: (prompt, signal) => callGemini(prompt, m, geminiKey, signal)
    }));
  }
  return list;
}

export function parseAIResponse(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    let cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    if (start === -1) throw new Error('Format JSON tidak valid.');
    cleaned = cleaned.substring(start);

    try { return JSON.parse(cleaned); } catch (e2) {}

    const lastValidBrace = cleaned.lastIndexOf('}');
    if (lastValidBrace > 0) {
      let repaired = cleaned.substring(0, lastValidBrace + 1);
      for (let i = 0; i < 5; i++) {
        try {
          return JSON.parse(repaired + ']}');
        } catch (err) {
          repaired = repaired.substring(0, repaired.lastIndexOf('}'));
        }
      }
    }
    throw new Error('Format JSON dari AI terpotong dan tidak bisa diperbaiki.');
  }
}

function lengkapiPenjelasan(soal) {
  soal.forEach(s => {
    if (!s.penjelasan || String(s.penjelasan).trim() === '') {
      s.penjelasan = 'Jawaban yang benar adalah ' + s.jawaban_benar + '.';
    }
  });
}

// Sama dengan generateWithBatching di api/index.js, ditambah onProgress dan signal.
// onProgress({ batch, totalBatch, soalSelesai, totalSoal }) dipanggil sebelum dan sesudah tiap batch.
export async function generateWithBatching({ materi, jumlahSoal, modelId, env, onProgress, signal }) {
  const providers = getAvailableProviders(env);
  if (providers.length === 0) throw new Error('Tidak ada API key.');

  // Model tidak dikenal -> pakai model pertama yang tersedia (default di sisi browser sudah ditentukan Vercel).
  const provider = providers.find(p => p.id === modelId) || providers[0];
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  const batches = [];
  let sisa = jumlahSoal;
  while (sisa > 0) {
    const n = Math.min(sisa, BATCH_SIZE);
    batches.push(n);
    sisa -= n;
  }

  const semuaSoal = [];
  let mode = 'buat_dari_materi';
  let judul = 'Kuis Latihan';
  let jumlahOpsi = 5;

  for (let i = 0; i < batches.length; i++) {
    if (signal && signal.aborted) throw new Error('Dibatalkan.');
    const n = batches[i];
    progress({ batch: i + 1, totalBatch: batches.length, soalSelesai: semuaSoal.length, totalSoal: jumlahSoal });

    const text = await provider.fn(buildPrompt(materi, n), signal);
    const parsed = parseAIResponse(text);

    if (parsed.soal && Array.isArray(parsed.soal)) {
      semuaSoal.push(...parsed.soal.slice(0, n));
    }
    mode = parsed.mode || mode;
    judul = parsed.judul || judul;
    jumlahOpsi = parsed.jumlah_opsi || jumlahOpsi;

    progress({ batch: i + 1, totalBatch: batches.length, soalSelesai: semuaSoal.length, totalSoal: jumlahSoal });
  }

  if (semuaSoal.length > jumlahSoal) semuaSoal.splice(jumlahSoal);
  lengkapiPenjelasan(semuaSoal);

  return {
    data: { mode, jumlah_opsi: jumlahOpsi, judul, soal: semuaSoal },
    provider: provider.id,
    providerName: provider.provider
  };
}

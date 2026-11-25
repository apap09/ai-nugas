// Tes logika generate dengan fetch palsu (tanpa internet, tanpa API key asli).
// Jalankan: node test/generate.test.mjs   (dari folder worker/)
import assert from 'node:assert/strict';
import { generateWithBatching, getAvailableProviders, parseAIResponse } from '../src/generate.js';

const realFetch = globalThis.fetch;
let calls = [];

function soal(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({
    pertanyaan: 'Soal ' + (offset + i + 1),
    pilihan: { A: 'a', B: 'b', C: 'c', D: 'd' },
    jawaban_benar: 'B'
    // sengaja tanpa "penjelasan" untuk menguji pengisian otomatis
  }));
}

// Meniru Groq: balas sejumlah soal sesuai angka "TEPAT N SOAL" di prompt, dengan jeda.
function mockGroq(delayMs) {
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const prompt = body.messages[1].content;
    const n = Number(/TEPAT (\d+) SOAL/.exec(prompt)[1]);
    calls.push({ url, n });
    await new Promise(r => setTimeout(r, delayMs));
    if (opts.signal && opts.signal.aborted) throw new Error('aborted');
    const content = JSON.stringify({ mode: 'buat_dari_materi', jumlah_opsi: 4, judul: 'Tes', soal: soal(n) });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
}

async function run(name, fn) {
  calls = [];
  try { await fn(); console.log('OK   ' + name); }
  catch (e) { console.error('GAGAL ' + name + '\n  ' + e.message); process.exitCode = 1; }
  finally { globalThis.fetch = realFetch; }
}

await run('25 soal dipecah 3 batch (10,10,5) dan progress dilaporkan', async () => {
  mockGroq(30);
  const progress = [];
  const r = await generateWithBatching({
    materi: 'x'.repeat(100), jumlahSoal: 25, modelId: 'openai/gpt-oss-20b',
    env: { GROQ_API_KEY: 'k' }, onProgress: p => progress.push(p)
  });
  assert.deepEqual(calls.map(c => c.n), [10, 10, 5]);
  assert.equal(r.data.soal.length, 25);
  assert.equal(r.provider, 'openai/gpt-oss-20b');
  assert.equal(r.providerName, 'Groq');
  assert.ok(r.data.soal.every(s => s.penjelasan));
  assert.equal(progress.length, 6);
  assert.deepEqual(progress[5], { batch: 3, totalBatch: 3, soalSelesai: 25, totalSoal: 25 });
});

await run('proses lama (di atas 60 detik di Vercel) tidak dipotong oleh kode', async () => {
  // jeda 300ms x 3 batch dipakai sebagai wakil; tidak ada batas 60 detik di generate.js
  mockGroq(300);
  const t0 = Date.now();
  await generateWithBatching({ materi: 'x'.repeat(100), jumlahSoal: 30, modelId: 'openai/gpt-oss-120b', env: { GROQ_API_KEY: 'k' } });
  assert.ok(Date.now() - t0 >= 900);
});

await run('model tidak dikenal -> pakai model pertama yang tersedia', async () => {
  mockGroq(1);
  const r = await generateWithBatching({ materi: 'x'.repeat(100), jumlahSoal: 3, modelId: 'model-ngawur', env: { GROQ_API_KEY: 'k' } });
  assert.equal(r.provider, 'openai/gpt-oss-120b');
});

await run('tanpa API key -> error jelas', async () => {
  await assert.rejects(
    generateWithBatching({ materi: 'x'.repeat(100), jumlahSoal: 3, modelId: 'a', env: {} }),
    /Tidak ada API key/
  );
});

await run('Groq didaftar sebelum Gemini', async () => {
  const list = getAvailableProviders({ GROQ_API_KEY: 'a', GEMINI_API_KEY: 'b' });
  assert.equal(list[0].provider, 'Groq');
  assert.equal(list[list.length - 1].provider, 'Gemini');
});

await run('pembatalan dari luar menghentikan batch berikutnya', async () => {
  mockGroq(50);
  const ac = new AbortController();
  const p = generateWithBatching({
    materi: 'x'.repeat(100), jumlahSoal: 30, modelId: 'openai/gpt-oss-120b',
    env: { GROQ_API_KEY: 'k' }, signal: ac.signal,
    onProgress: pr => { if (pr.batch === 1 && pr.soalSelesai === 10) ac.abort(); }
  });
  await assert.rejects(p, /Dibatalkan|abort/i);
  assert.ok(calls.length < 3);
});

await run('parseAIResponse memperbaiki JSON berpagar kode dan JSON terpotong', async () => {
  assert.equal(parseAIResponse('```json\n{"a":1}\n```').a, 1);
  const terpotong = '{"soal":[{"pertanyaan":"a"},{"pertanyaan":"b"},{"pertan';
  assert.equal(parseAIResponse(terpotong).soal.length, 2);
});

// ====== RETRY + CADANGAN MODEL ======
// Gemini palsu: gagal "high demand" sebanyak `gagalDulu` kali, lalu sukses. Groq palsu: selalu sukses.
function mockCampur({ gagalGemini, groqOk = true }) {
  let gagalSisa = gagalGemini;
  globalThis.fetch = async (url, opts) => {
    const isGemini = String(url).includes('generativelanguage');
    const prompt = isGemini
      ? JSON.parse(opts.body).contents[0].parts[0].text
      : JSON.parse(opts.body).messages[1].content;
    const n = Number(/TEPAT (\d+) SOAL/.exec(prompt)[1]);
    calls.push({ host: isGemini ? 'gemini' : 'groq', n });
    const body = JSON.stringify({ judul: 'T', soal: soal(n) });

    if (isGemini) {
      if (gagalSisa > 0) {
        gagalSisa--;
        return new Response(JSON.stringify({ error: { message: 'This model is currently experiencing high demand.' } }), { status: 503 });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: body }] } }] }), { status: 200 });
    }
    if (!groqOk) return new Response(JSON.stringify({ error: { message: 'over capacity' } }), { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 });
  };
}

const ENV_DUA = { GROQ_API_KEY: 'k', GEMINI_API_KEY: 'k' };

await run('503 high demand di Gemini dicoba ulang lalu berhasil (tanpa pindah model)', async () => {
  mockCampur({ gagalGemini: 2 });
  const infos = [];
  const r = await generateWithBatching({
    materi: 'x'.repeat(100), jumlahSoal: 10, modelId: 'gemini-3.1-flash-lite', env: ENV_DUA,
    retryDelaysMs: [1, 1], onProgress: p => { if (p.info) infos.push(p.info); }
  });
  assert.equal(r.provider, 'gemini-3.1-flash-lite');
  assert.equal(calls.filter(c => c.host === 'gemini').length, 3);
  assert.equal(calls.filter(c => c.host === 'groq').length, 0);
  assert.equal(infos.length, 2);
  assert.equal(r.data.soal.length, 10);
});

await run('Gemini terus sibuk -> batch dipindah ke Groq dan hasil tetap lengkap 50 soal', async () => {
  mockCampur({ gagalGemini: 999 });
  const r = await generateWithBatching({
    materi: 'x'.repeat(100), jumlahSoal: 50, modelId: 'gemini-3.1-flash-lite', env: ENV_DUA, retryDelaysMs: [1, 1]
  });
  assert.equal(r.data.soal.length, 50);
  assert.equal(r.providerName, 'Groq');
  assert.equal(calls.filter(c => c.host === 'groq').length, 5);
});

await run('semua model sibuk -> error jelas, bukan menggantung', async () => {
  mockCampur({ gagalGemini: 999, groqOk: false });
  await assert.rejects(
    generateWithBatching({ materi: 'x'.repeat(100), jumlahSoal: 10, modelId: 'gemini-3.1-flash-lite', env: ENV_DUA, retryDelaysMs: [1] }),
    /Semua model sedang sibuk/
  );
});

await run('pembatalan saat menunggu retry berhenti cepat', async () => {
  mockCampur({ gagalGemini: 999 });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const t0 = Date.now();
  await assert.rejects(
    generateWithBatching({ materi: 'x'.repeat(100), jumlahSoal: 10, modelId: 'gemini-3.1-flash-lite', env: ENV_DUA, retryDelaysMs: [5000], signal: ac.signal }),
    /Dibatalkan/
  );
  assert.ok(Date.now() - t0 < 1000);
});

console.log(process.exitCode ? '\nAda tes yang gagal.' : '\nSemua tes lolos.');

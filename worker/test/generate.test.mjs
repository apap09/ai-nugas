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

console.log(process.exitCode ? '\nAda tes yang gagal.' : '\nSemua tes lolos.');

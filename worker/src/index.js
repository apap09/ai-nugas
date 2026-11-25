// Worker + Durable Object untuk generate soal lewat WebSocket.
// Browser (halaman di Vercel) -> wss://<worker>/ws -> Durable Object -> API Groq/Gemini.
// Selama WebSocket dari browser masih terbuka, Durable Object tetap aktif, jadi
// proses generate tidak kena batas durasi function Vercel.

import { DurableObject } from 'cloudflare:workers';
import { generateWithBatching, MAX_MATERI_CHARS, MAX_SOAL } from './generate.js';

const MIN_MATERI_CHARS = 30;

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* koneksi sudah tertutup */ }
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// ====== WORKER: gerbang, cek asal permintaan, lalu serahkan ke Durable Object ======
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok');
    }

    if (url.pathname !== '/ws') {
      return new Response('Nugas.AI WebSocket', { status: 200 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Butuh koneksi WebSocket.', { status: 426 });
    }

    // Hanya halaman dari domain yang diizinkan (ALLOWED_ORIGINS di wrangler.jsonc).
    const origin = request.headers.get('Origin') || '';
    if (!allowedOrigins(env).includes(origin)) {
      return new Response('Origin tidak diizinkan.', { status: 403 });
    }

    // Satu Durable Object baru per koneksi. Tidak ada state yang perlu dibagi antar user.
    const id = env.GENERATOR.newUniqueId();
    return env.GENERATOR.get(id).fetch(request);
  }
};

// ====== DURABLE OBJECT: memegang satu WebSocket dan menjalankan proses generate ======
export class Generator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.busy = false;
    this.abortController = null;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API: kalau tidak ada pekerjaan, object boleh tidur dan tidak ditagih durasi.
    this.ctx.acceptWebSocket(server);

    // Balasan otomatis untuk heartbeat dari browser; tidak membangunkan object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string') return;

    let msg;
    try { msg = JSON.parse(raw); } catch (e) {
      return send(ws, { type: 'error', error: 'Pesan tidak valid.' });
    }
    if (!msg || msg.type !== 'generate') return;

    if (this.busy) {
      return send(ws, { type: 'error', error: 'Masih ada proses generate yang berjalan.' });
    }

    const materi = String(msg.text || '').slice(0, MAX_MATERI_CHARS);
    if (materi.trim().length < MIN_MATERI_CHARS) {
      return send(ws, { type: 'error', error: 'Materi terlalu pendek.' });
    }
    const jumlahSoal = Math.min(Math.max(parseInt(msg.jumlahSoal) || 10, 1), MAX_SOAL);

    this.busy = true;
    this.abortController = new AbortController();

    try {
      const result = await generateWithBatching({
        materi,
        jumlahSoal,
        modelId: msg.provider,
        env: this.env,
        signal: this.abortController.signal,
        onProgress: (p) => send(ws, { type: 'progress', ...p })
      });
      send(ws, {
        type: 'done',
        success: true,
        data: result.data,
        provider: result.provider,
        providerName: result.providerName
      });
    } catch (err) {
      send(ws, { type: 'error', error: (err && err.message) || 'Gagal generate soal.' });
    } finally {
      this.busy = false;
      this.abortController = null;
    }
  }

  // Browser menutup tab / koneksi: hentikan panggilan AI supaya kuota tidak terbuang.
  async webSocketClose(ws, code, reason, wasClean) {
    if (this.abortController) this.abortController.abort();
    try { ws.close(code, 'selesai'); } catch (e) { /* sudah tertutup */ }
  }

  async webSocketError(ws, error) {
    if (this.abortController) this.abortController.abort();
  }
}

// Frame-exact video export: encodes rendered frames with WebCodecs (VP9 or VP8) and writes a WebM file.
// Unlike MediaRecorder this doesn't depend on real-time playback, so every frame is kept at any resolution.

// ---------- minimal EBML / WebM writer ----------
const enc = new TextEncoder();
function vint(n) {
  // element size as an 8-byte EBML variable-length integer (simple and always valid)
  const b = new Uint8Array(8);
  b[0] = 0x01;
  let v = BigInt(n);
  for (let i = 7; i >= 1; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}
function idBytes(id) { const out = []; let x = id; while (x > 0) { out.unshift(x & 0xff); x = Math.floor(x / 256); } return new Uint8Array(out); }
function uint(v) { const out = []; let x = BigInt(Math.max(0, Math.round(v))); do { out.unshift(Number(x & 0xffn)); x >>= 8n; } while (x > 0n); return new Uint8Array(out); }
function float64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b; }
const concat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let k = 0; for (const p of parts) { out.set(p, k); k += p.length; } return out; };
const el = (id, ...children) => { const body = concat(children.map((c) => (typeof c === 'string' ? enc.encode(c) : c))); return concat([idBytes(id), vint(body.length), body]); };

function muxWebM(chunks, { width, height, fps, codec }) {
  const durationMs = (chunks.length * 1000) / fps;
  const header = el(0x1a45dfa3, el(0x4286, uint(1)), el(0x42f7, uint(1)), el(0x42f2, uint(4)), el(0x42f3, uint(8)), el(0x4282, 'webm'), el(0x4287, uint(2)), el(0x4285, uint(2)));
  const info = el(0x1549a966, el(0x2ad7b1, uint(1000000)), el(0x4d80, 'Ruffle3D'), el(0x5741, 'Ruffle3D'), el(0x4489, float64(durationMs)));
  const tracks = el(0x1654ae6b, el(0xae, el(0xd7, uint(1)), el(0x73c5, uint(1)), el(0x83, uint(1)), el(0x86, codec === 'vp9' ? 'V_VP9' : 'V_VP8'), el(0x23e383, uint(Math.round(1e9 / fps))), el(0xe0, el(0xb0, uint(width)), el(0xba, uint(height)))));
  // one cluster per second of video (relative block timecodes must fit in 16 bits)
  const clusters = [];
  let i = 0;
  while (i < chunks.length) {
    const t0 = Math.round(chunks[i].timestamp / 1000);
    const blocks = [];
    for (; i < chunks.length; i++) {
      const tm = Math.round(chunks[i].timestamp / 1000);
      if (tm - t0 >= 1000 && blocks.length) break;
      const hdr = new Uint8Array(4);
      hdr[0] = 0x81; // track 1
      new DataView(hdr.buffer).setInt16(1, tm - t0);
      hdr[3] = chunks[i].type === 'key' ? 0x80 : 0x00;
      blocks.push(el(0xa3, hdr, chunks[i].data));
    }
    clusters.push(el(0x1f43b675, el(0xe7, uint(t0)), ...blocks));
  }
  const segment = el(0x18538067, info, tracks, ...clusters);
  return new Blob([header, segment], { type: 'video/webm' });
}

export const canEncodeWebM = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';

/**
 * Encodes `frames` frames. drawFrame(i) must render frame i to `canvas` before returning.
 * Returns a WebM Blob.
 */
export async function encodeWebM(canvas, { frames, fps = 30, width, height, bitrate = 8e6, drawFrame, onProgress }) {
  const candidates = [['vp09.00.10.08', 'vp9'], ['vp8', 'vp8']];
  let chosen = null;
  for (const [codecString, codec] of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({ codec: codecString, width, height, bitrate, framerate: fps });
      if (support.supported) { chosen = { codecString, codec }; break; }
    } catch { /* try the next codec */ }
  }
  if (!chosen) throw new Error('This browser cannot encode VP9 or VP8 video');
  const chunks = [];
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk) => { const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); chunks.push({ type: chunk.type, timestamp: chunk.timestamp, data }); },
    error: (e) => { failure = e; },
  });
  encoder.configure({ codec: chosen.codecString, width, height, bitrate, framerate: fps });
  for (let i = 0; i < frames; i++) {
    if (failure) throw failure;
    await drawFrame(i);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    onProgress?.((i + 1) / frames);
    while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 2));
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  chunks.sort((a, b) => a.timestamp - b.timestamp);
  return muxWebM(chunks, { width, height, fps, codec: chosen.codec });
}

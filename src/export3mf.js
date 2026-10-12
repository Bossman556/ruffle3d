// 3MF export (3D Manufacturing Format): welded, colour-tagged meshes in millimetres, packaged as a ZIP.
// bodies: [{ name, color: '#rrggbb', positions: Float32Array (xyz…), index: Uint32Array }]

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

async function deflateRaw(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('deflate-raw');
  const out = new Response(new Blob([u8]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(await out);
}

/** ZIP archive from [{ name, data: Uint8Array }] (deflate when the platform supports it). */
export async function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), crc = crc32(e.data);
    const comp = await deflateRaw(e.data);
    const useDeflate = comp && comp.length < e.data.length;
    const body = useDeflate ? comp : e.data;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, useDeflate ? 8 : 0, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, body.length, true); lh.setUint32(22, e.data.length, true); lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, body);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, useDeflate ? 8 : 0, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, body.length, true); ch.setUint32(24, e.data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let k = 0;
  for (const a of all) { out.set(a, k); k += a.length; }
  return out;
}

// Merges coincident vertices (the display mesh duplicates vertices along face boundaries) so slicers see a closed mesh.
export function weld(positions, index, tol = 1e-5) {
  const map = new Map(), verts = [], remap = new Uint32Array(positions.length / 3);
  const q = (v) => Math.round(v / tol);
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const key = `${q(x)},${q(y)},${q(z)}`;
    let j = map.get(key);
    if (j === undefined) { j = verts.length / 3; map.set(key, j); verts.push(x, y, z); }
    remap[i] = j;
  }
  const tris = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = remap[index[t]], b = remap[index[t + 1]], c = remap[index[t + 2]];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  return { verts, tris };
}

export async function build3MF(bodies, title = 'Ruffle3D model') {
  const f = (v) => +v.toFixed(5);
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n`;
  xml += ` <metadata name="Title">${esc(title)}</metadata>\n <metadata name="Application">Ruffle3D</metadata>\n <resources>\n  <basematerials id="1">\n`;
  bodies.forEach((b) => { xml += `   <base name="${esc(b.name)}" displaycolor="${(b.color || '#b9c0c8').toUpperCase()}FF"/>\n`; });
  xml += '  </basematerials>\n';
  bodies.forEach((b, i) => {
    const { verts, tris } = weld(b.positions, b.index);
    xml += `  <object id="${i + 2}" type="model" name="${esc(b.name)}" pid="1" pindex="${i}">\n   <mesh>\n    <vertices>\n`;
    for (let k = 0; k < verts.length; k += 3) xml += `     <vertex x="${f(verts[k])}" y="${f(verts[k + 1])}" z="${f(verts[k + 2])}"/>\n`;
    xml += '    </vertices>\n    <triangles>\n';
    for (let k = 0; k < tris.length; k += 3) xml += `     <triangle v1="${tris[k]}" v2="${tris[k + 1]}" v3="${tris[k + 2]}"/>\n`;
    xml += '    </triangles>\n   </mesh>\n  </object>\n';
  });
  xml += ' </resources>\n <build>\n';
  bodies.forEach((_, i) => { xml += `  <item objectid="${i + 2}"/>\n`; });
  xml += ' </build>\n</model>\n';
  const enc = new TextEncoder();
  return makeZip([
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n') },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n') },
    { name: '3D/3dmodel.model', data: enc.encode(xml) },
  ]);
}

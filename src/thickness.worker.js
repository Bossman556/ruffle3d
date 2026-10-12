// Web Worker for wall-thickness analysis (display meshes are refined so colours vary smoothly).
import { wallThickness } from './thickness.js';
import { refineMesh } from './fea.js';

self.onmessage = ({ data }) => {
  try {
    const out = [], buffers = [];
    data.bodies.forEach((b, i) => {
      const mesh = refineMesh(b.positions, b.normals, b.index, b.faceGroups, b.target, 400000);
      const values = wallThickness(mesh.positions, mesh.normals, mesh.index, (p) => self.postMessage({ type: 'progress', p: (i + p) / data.bodies.length }));
      out.push({ id: b.id, mesh, values });
      buffers.push(mesh.positions.buffer, mesh.normals.buffer, mesh.index.buffer, values.buffer);
    });
    self.postMessage({ type: 'done', bodies: out }, buffers);
  } catch (e) {
    self.postMessage({ type: 'error', error: e?.message || String(e) });
  }
};

// Web Worker running the simulation solvers, so a long study never blocks modelling.
import { solveStatic, solveModal, optimizeTopology, solveThermal, solveBuckling, solvePlastic } from './fea.js';

self.onmessage = ({ data }) => {
  try {
    let last = 0;
    const onProgress = (p, text) => {
      const now = performance.now();
      if (now - last > 120 || p >= 1) { last = now; self.postMessage({ type: 'progress', p, text }); }
    };
    const run = { static: data.plastic ? solvePlastic : solveStatic, modal: solveModal, topology: optimizeTopology, thermal: solveThermal, buckling: solveBuckling }[data.study || 'static'];
    const result = run({ ...data, onProgress });
    const buffers = [];
    const add = (a) => { if (a?.buffer && !buffers.includes(a.buffer)) buffers.push(a.buffer); };
    add(result.vonMises); add(result.displacement); add(result.plasticStrain); add(result.density); add(result.temperature);
    if (result.display) { add(result.display.positions); add(result.display.normals); add(result.display.index); }
    if (result.surface) { add(result.surface.positions); add(result.surface.index); }
    for (const m of result.modes || []) add(m.shape);
    self.postMessage({ type: 'done', result }, buffers);
  } catch (e) {
    self.postMessage({ type: 'error', error: e?.message || String(e) });
  }
};

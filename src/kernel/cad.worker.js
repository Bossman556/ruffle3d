// Web Worker hosting the OpenCascade kernel so modelling never blocks the UI.
import opencascade from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { setOC } from 'replicad';
import { registerFont } from './text.js';
import { rebuild, meshShape, properties, exportShapes, interference, projectViews, emptyState, measurePicks, hasSolid, curvatureField, curvatureCombs, curvePolyline, faceDXF, flatPattern, sectionView, camToolpaths, drawingHoles, compareWithFeatures, solveAssembly } from './build.js';

const ready = (async () => {
  const OC = await opencascade({ locateFile: () => wasmUrl });
  setOC(OC);
})();

let last = null; // { states, errors, warnings } of the most recent build
const finalState = () => (last?.states.length ? last.states[last.states.length - 1] : emptyState());

function packState(state, have) {
  const bodies = [];
  const transfer = [];
  for (const [id, shape] of state.bodies) {
    try {
      const m = meshShape(shape);
      if (m.surface === undefined) m.surface = !hasSolid(shape);
      const entry = { id, uid: m.uid, surface: m.surface, sheet: !!state.sheets?.has(id) };
      if (!have.has(m.uid)) {
        // copy so the cached buffers stay usable in the worker
        const mesh = { ...m.mesh, vertices: m.mesh.vertices.slice(), normals: m.mesh.normals.slice(), triangles: m.mesh.triangles.slice(), lines: m.mesh.lines.slice() };
        entry.mesh = mesh;
        transfer.push(mesh.vertices.buffer, mesh.normals.buffer, mesh.triangles.buffer, mesh.lines.buffer);
      }
      bodies.push(entry);
    } catch {
      bodies.push({ id, error: 'Could not tessellate body' });
    }
  }
  const sketches = [...state.sketches].map(([id, s]) => ({ id, plane: s.plane, geom: s.geom, ...(s.proj ? { proj: s.proj } : {}) }));
  const planes = [...state.planes].map(([id, plane]) => ({ id, plane }));
  const joints = [...state.joints].map(([id, j]) => ({ id, ...j }));
  const curves = [...(state.curves || [])].map(([id, c]) => {
    if (!c.poly) { try { c.poly = curvePolyline(c.wire); } catch { c.poly = []; } }
    return { id, pts: c.poly, cvs: c.cvs, degree: c.degree, closed: c.closed, plane: c.plane };
  });
  const cvgrids = [...(state.cvgrids || [])].map(([id, g]) => ({ id, ...g }));
  return { bodies, sketches, planes, joints, curves, cvgrids, transfer };
}

self.onmessage = async ({ data: msg }) => {
  const reply = (payload, transfer = []) => self.postMessage({ id: msg.id, ...payload }, transfer);
  try {
    await ready;
    if (msg.type === 'build') {
      const t0 = performance.now();
      last = await rebuild(msg.features);
      // assemblies: solve the mates and move the components (the cached states keep the unsolved poses)
      let assembly = null;
      const fin = finalState();
      if (fin.components?.size) {
        const solved = solveAssembly(fin, msg.mates || []);
        last.states[last.states.length - 1] = solved.state;
        assembly = solved.assembly;
      }
      const have = new Set(msg.have || []);
      const out = packState(finalState(), have);
      let base = null;
      const transfer = [...out.transfer];
      if (msg.baseIndex != null) {
        // state just before a feature: used for picking edges/faces while editing that feature
        const bs = msg.baseIndex > 0 ? last.states[msg.baseIndex - 1] : emptyState();
        const b = packState(bs, new Set([...have, ...out.bodies.map((x) => x.uid)]));
        base = { bodies: b.bodies, sketches: b.sketches, planes: b.planes, curves: b.curves };
        transfer.push(...b.transfer);
      }
      delete out.transfer;
      reply({ ok: true, ...out, errors: last.errors, warnings: last.warnings, base, assembly, ms: performance.now() - t0 }, transfer);
    } else if (msg.type === 'props') {
      const shape = finalState().bodies.get(msg.body);
      if (!shape) throw new Error('Body not found');
      reply({ ok: true, props: properties(shape) });
    } else if (msg.type === 'export') {
      const st = finalState();
      const list = msg.bodies.map((b) => ({ shape: st.bodies.get(b.id), name: b.name, color: b.color })).filter((b) => b.shape);
      if (!list.length) throw new Error('Nothing to export');
      const blob = exportShapes(list, msg.format);
      reply({ ok: true, buffer: await blob.arrayBuffer() });
    } else if (msg.type === 'interference') {
      const st = finalState();
      const entries = msg.bodies.map((id) => [id, st.bodies.get(id)]).filter(([, s]) => s);
      reply({ ok: true, results: interference(entries) });
    } else if (msg.type === 'curvature') {
      const shape = finalState().bodies.get(msg.body);
      if (!shape) throw new Error('Body not found');
      const values = curvatureField(shape);
      reply({ ok: true, values }, [values.buffer]);
    } else if (msg.type === 'combs') {
      reply({ ok: true, combs: curvatureCombs(finalState(), msg.picks) });
    } else if (msg.type === 'dxf') {
      reply({ ok: true, text: faceDXF(finalState(), msg.pick) });
    } else if (msg.type === 'compare') {
      const result = await compareWithFeatures(finalState(), msg.features);
      const transfer = [];
      for (const r of result) for (const p of [r.added, r.removed]) if (p) transfer.push(p.mesh.vertices.buffer, p.mesh.normals.buffer, p.mesh.triangles.buffer);
      reply({ ok: true, result }, transfer);
    } else if (msg.type === 'cam') {
      reply({ ok: true, result: camToolpaths(finalState(), msg.cam) });
    } else if (msg.type === 'font') {
      await registerFont(msg.id, msg.data);
      reply({ ok: true });
    } else if (msg.type === 'flat') {
      const { ents, bends, size, thickness, kfactor, radius, dxf } = flatPattern(finalState(), msg.body);
      reply({ ok: true, ents, bends, size, thickness, kfactor, radius, dxf });
    } else if (msg.type === 'measure') {
      reply({ ok: true, result: measurePicks(finalState(), msg.picks) });
    } else if (msg.type === 'drawing') {
      const st = finalState();
      const shapes = msg.bodies.map((id) => st.bodies.get(id)).filter(Boolean);
      if (!shapes.length) throw new Error('No visible bodies to draw');
      const views = projectViews(shapes, msg.views);
      if (msg.section) { try { views.push(sectionView(shapes, msg.section)); } catch (e) { views.push({ view: 'section', error: e.message }); } }
      const props = shapes.length === 1 ? properties(shapes[0]) : null;
      const parts = msg.bodies.map((id) => { const s = st.bodies.get(id); try { const pr = properties(s); return { id, volume: pr.volume, center: pr.centerOfMass, bbox: pr.bbox }; } catch { return { id, volume: 0 }; } });
      let holes = [];
      try { holes = drawingHoles(shapes); } catch { /* no callouts */ }
      reply({ ok: true, views, props, parts, holes });
    } else {
      throw new Error(`Unknown message ${msg.type}`);
    }
  } catch (e) {
    reply({ ok: false, error: e?.message || String(e) });
  }
};

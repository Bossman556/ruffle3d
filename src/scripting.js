// Scripting: JavaScript macros that build and query designs through a small API (r3d).
// A script runs as an async function in the app page, so it can do anything the app can; the Scripts
// window says to run only scripts you trust. One run is one undo step.
import { FEATURES, defaultsFor } from './features.js';
import { STD_PLANES } from './geom2d.js';

const STD = new Set(['XY', 'XZ', 'YZ']);
let seq = 0;
const uid = (p) => `${p}s${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A sketch builder: geometry in sketch coordinates (mm). Points shared by curves are merged. */
export function sketchBuilder() {
  const points = [], curves = [];
  const pt = (x, y) => {
    const ex = points.find((q) => Math.hypot(q.x - x, q.y - y) < 1e-9);
    if (ex) return ex.id;
    const id = uid('p');
    points.push({ id, x, y });
    return id;
  };
  const b = {
    line(x1, y1, x2, y2) { curves.push({ id: uid('c'), type: 'line', a: pt(x1, y1), b: pt(x2, y2) }); return b; },
    polyline(pts, closed = false) { for (let i = 0; i + 1 < pts.length; i++) b.line(...pts[i], ...pts[i + 1]); if (closed && pts.length > 2) b.line(...pts[pts.length - 1], ...pts[0]); return b; },
    rect(x1, y1, x2, y2) { return b.polyline([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], true); },
    centerRect(cx, cy, w, h) { return b.rect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2); },
    circle(cx, cy, r) { curves.push({ id: uid('c'), type: 'circle', c: pt(cx, cy), r }); return b; },
    // radii along and across the major axis, which is turned rot degrees from X
    ellipse(cx, cy, rx, ry, rot = 0) {
      const a = (rot * Math.PI) / 180;
      curves.push({ id: uid('c'), type: 'ellipse', c: pt(cx, cy), a: pt(cx + rx * Math.cos(a), cy + rx * Math.sin(a)), rb: ry });
      return b;
    },
    // counter-clockwise from angle a0 to a1 (degrees)
    arc(cx, cy, r, a0, a1) {
      const P = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
      curves.push({ id: uid('c'), type: 'arc', c: pt(cx, cy), a: pt(...P(a0)), b: pt(...P(a1)) });
      return b;
    },
    polygon(cx, cy, r, n = 6, rot = 0) { return b.polyline(Array.from({ length: n }, (_, i) => { const a = rot + (i * 2 * Math.PI) / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }), true); },
    slot(x1, y1, x2, y2, w) {
      const r = w / 2, a = Math.atan2(y2 - y1, x2 - x1), nx = -Math.sin(a) * r, ny = Math.cos(a) * r, deg = (a * 180) / Math.PI;
      b.line(x1 + nx, y1 + ny, x2 + nx, y2 + ny).line(x2 - nx, y2 - ny, x1 - nx, y1 - ny);
      b.arc(x2, y2, r, deg - 90, deg + 90).arc(x1, y1, r, deg + 90, deg + 270);
      return b;
    },
    spline(pts, closed = false) { curves.push({ id: uid('c'), type: 'spline', pts: pts.map(([x, y]) => pt(x, y)), closed }); return b; },
    data: () => ({ points, curves, constraints: [], dims: [] }),
  };
  return b;
}

/** The API a script gets. log(text, kind) receives its output. */
export function makeAPI(app, log) {
  const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v, (k, x) => (typeof x === 'number' ? +x.toPrecision(10) : x)));
  const add = (type, params = {}, name) => {
    const def = FEATURES[type];
    if (!def) throw new Error(`Unknown feature type "${type}". Types: ${Object.keys(FEATURES).join(', ')}`);
    const p = { ...defaultsFor(type, app.ctx()) };
    for (const [k, v] of Object.entries(params)) {
      const fld = def.fields.find((x) => x.key === k);
      p[k] = fld && (fld.type === 'number' || fld.type === 'int') && typeof v === 'number' ? String(v) : v;
    }
    const f = { id: uid(type.slice(0, 3)), type, name: name || `${def.label} ${app.doc.features.filter((x) => x.type === type).length + 1}`, p };
    app.doc.features.splice(app.doc.marker, 0, f);
    app.doc.marker++;
    return f.id;
  };
  const planeRef = (pl) => (typeof pl === 'string' && STD.has(pl.toUpperCase()) ? { type: 'std', name: pl.toUpperCase() } : null);
  const api = {
    log: (...a) => log(a.map(fmt).join(' ')),
    get units() { return app.doc.units; },
    /** Read a parameter, or create / change it: param('width', 60) or param('width', 'base * 2'). */
    param(name, expr) {
      let p = app.doc.params.find((x) => x.name === name);
      if (expr === undefined) return p?.expr;
      if (!p) { p = { name, expr: String(expr) }; app.doc.params.push(p); } else p.expr = String(expr);
      return p.expr;
    },
    /** Any timeline feature by type, with its parameters (see the feature dialog for names). Returns its id, which is also the id of the body it makes (if it makes a new one). */
    feature: add,
    /** A sketch on 'XY', 'XZ' or 'YZ' (or a plane { origin, xDir, normal }): sketch('XY', (s) => s.rect(-30, -20, 30, 20)). */
    sketch(plane, build, name) {
      const b = sketchBuilder();
      build(b);
      const ref = planeRef(plane);
      const pl = ref ? null : plane;
      if (!ref && !(pl?.origin && pl?.normal && pl?.xDir)) throw new Error("sketch() needs 'XY', 'XZ', 'YZ' or { origin, xDir, normal }");
      return add('sketch', { ...b.data(), ...(ref ? { planeRef: ref, plane: structuredClone(STD_PLANES[ref.name]) } : { plane: pl, planeRef: null }) }, name);
    },
    extrude: (sketch, distance, opts = {}, name) => add('extrude', { sketch, profiles: [], distance, ...opts }, name),
    revolve: (sketch, opts = {}, name) => add('revolve', { sketch, profiles: [], ...opts }, name),
    box: (p, name) => add('box', p, name),
    cylinder: (p, name) => add('cylinder', p, name),
    /** Holes at points on a body's face: hole(body, [[x, y, z], …], [nx, ny, nz], { standard: 'cbore', size: 'M6', through: true }). */
    hole: (body, points, normal = [0, 0, 1], opts = {}, name) => add('hole', { points: points.map((q) => ({ body, p: q, n: normal })), ...opts }, name),
    /** Rebuild the model now (scripts rebuild automatically at the end). Returns { bodies, errors }. */
    async rebuild() {
      await app.rebuild();
      const errors = Object.fromEntries(Object.entries(app.result.errors || {}).map(([id, e]) => [app.doc.features.find((f) => f.id === id)?.name || id, e]));
      return { bodies: api.bodies(), errors };
    },
    bodies: () => app.result.bodies.map((b) => ({ id: b.id, name: app.bodyMeta(b.id).name, material: app.bodyMeta(b.id).material })),
    /** Mass properties of a body: volume (mm³), area (mm²), mass (g), centre of mass, bounding box. */
    async properties(id) {
      const pr = (await app.kernel.props(id)).props, meta = app.bodyMeta(id);
      const density = (await import('./materials.js')).MATERIALS[meta.material]?.density || 1;
      return { volume: pr.volume, area: pr.area, mass: (pr.volume / 1000) * density, centerOfMass: pr.centerOfMass, bbox: pr.bbox };
    },
    material(id, key) { app.bodyMeta(id).material = key; },
    /** Download bodies as 'step', 'stl' or '3mf' (all visible bodies by default). */
    async export(format, ids) { await app.exportBodies(format, ids); },
    /** Switch to a configuration by name (null for Default). */
    configure(name) { const c = (app.doc.configs || []).find((x) => x.name === name); app.doc.activeConfig = c ? c.id : null; },
  };
  return api;
}

/** Runs a script; resolves to { ok, error, line }. */
export async function runScript(app, code, log) {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  let fn;
  try { fn = new AsyncFunction('r3d', 'console', `"use strict";\n${code}`); } catch (e) { log(`Syntax error: ${e.message}`, 'err'); return { ok: false, error: e.message }; }
  const api = makeAPI(app, log);
  const con = { log: api.log, warn: (...a) => log(a.join(' '), 'warn'), error: (...a) => log(a.join(' '), 'err') };
  try {
    await fn(api, con);
    return { ok: true };
  } catch (e) {
    // the script's own line number: the generated function adds three lines (its header and "use strict")
    const m = String(e.stack || '').match(/<anonymous>:(\d+):\d+/);
    const line = m ? +m[1] - 3 : null;
    log(`${e.message}${line ? ` (line ${line})` : ''}`, 'err');
    return { ok: false, error: e.message, line };
  }
}

export const EXAMPLES = [
  {
    name: 'Plate with a hole pattern',
    code: `// A plate driven by parameters, with a grid of counterbored M5 holes
r3d.param('w', 120);
r3d.param('d', 80);
r3d.param('t', 8);

const s = r3d.sketch('XY', (sk) => sk.centerRect(0, 0, 120, 80), 'Plate sketch');
// a feature that makes a new body returns that body's id
const plate = r3d.extrude(s, 't', {}, 'Plate');
await r3d.rebuild();

const pts = [];
for (const x of [-45, -15, 15, 45]) for (const y of [-25, 25]) pts.push([x, y, 8]);
r3d.hole(plate, pts, [0, 0, 1], { standard: 'cbore', size: 'M5', through: true }, 'M5 holes');

const { errors } = await r3d.rebuild();
r3d.log('Errors:', errors);
r3d.log('Mass:', (await r3d.properties(plate)).mass.toFixed(1), 'g');`,
  },
  {
    name: 'Mass for a range of sizes',
    code: `// A bar whose length is a parameter: change it and record the mass of each size
r3d.param('len', 50);
const id = r3d.box({ w: 'len', d: 20, h: 6 }, 'Bar');
await r3d.rebuild();
r3d.material(id, 'steel');
for (const L of [40, 60, 80, 100]) {
  r3d.param('len', L);
  await r3d.rebuild();
  r3d.log(\`length \${L} mm: \${(await r3d.properties(id)).mass.toFixed(1)} g\`);
}`,
  },
  {
    name: 'Flange with bolt circle',
    code: `// A round flange with a ring of holes, using a revolve and a hole pattern
const D = 120, bore = 40, n = 6, pcd = 90;
const s = r3d.sketch('XY', (sk) => sk.circle(0, 0, D / 2).circle(0, 0, bore / 2));
const f = r3d.extrude(s, 12, {}, 'Flange');
await r3d.rebuild();
const pts = Array.from({ length: n }, (_, i) => [pcd / 2 * Math.cos(2 * Math.PI * i / n), pcd / 2 * Math.sin(2 * Math.PI * i / n), 12]);
r3d.hole(f, pts, [0, 0, 1], { standard: 'clearance', size: 'M10', through: true }, 'Bolt holes');
await r3d.rebuild();
r3d.log('Volume', (await r3d.properties(f)).volume.toFixed(0), 'mm³');`,
  },
];

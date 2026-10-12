// Surface modelling: extrude / revolve / skin / rail / patch / offset surfaces, thicken, stitch,
// plus curvature evaluation (map + combs).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, properties, hasSolid, curvatureField, curvatureCombs, meshShape } from '../src/kernel/build.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));

let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

const XY = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const XZ = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
const at = (z) => ({ origin: [0, 0, z], xDir: [1, 0, 0], normal: [0, 0, 1] });
let n = 0;
// sketch feature from a list of 2D polyline/spline descriptions
function sketch(id, plane, items) {
  const points = [], curves = [];
  const pt = (x, y) => { const pid = `p${n++}`; points.push({ id: pid, x, y }); return pid; };
  for (const it of items) {
    if (it.spline) curves.push({ id: `c${n++}`, type: 'spline', pts: it.spline.map(([x, y]) => pt(x, y)), closed: !!it.closed });
    if (it.line) { const [a, b] = it.line; curves.push({ id: `c${n++}`, type: 'line', a: pt(...a), b: pt(...b) }); }
    if (it.circle) { const [c, r] = it.circle; curves.push({ id: `c${n++}`, type: 'circle', c: pt(...c), r }); }
  }
  return { id, type: 'sketch', p: { plane, points, curves, constraints: [], dims: [] } };
}
const wave = [[-30, 0], [-10, 8], [10, -8], [30, 0]];

// --- extrude surface from an open spline
let r = await rebuild([sketch('s1', XY, [{ spline: wave }]), { id: 'e1', type: 'surfextrude', p: { sketch: 's1', side: 'one', distance: 25 } }]);
let st = r.states.at(-1);
check('extrude surface builds', !Object.keys(r.errors).length, JSON.stringify(r.errors));
const e1 = st.bodies.get('e1');
check('extrude surface is a surface (no solid)', e1 && !hasSolid(e1));
check('extrude surface has area, no volume', e1 && properties(e1).area > 60 * 25 && Math.abs(properties(e1).volume) < 1e-6, e1 && properties(e1).area.toFixed(1));

// --- thicken it into a solid
r = await rebuild([sketch('s1', XY, [{ spline: wave }]), { id: 'e1', type: 'surfextrude', p: { sketch: 's1', side: 'one', distance: 25 } }, { id: 't1', type: 'thicken', p: { body: 'e1', thickness: 2, side: 'out' } }]);
st = r.states.at(-1);
const thick = st.bodies.get('e1');
check('thicken builds', !r.errors.t1, r.errors.t1);
check('thickened body is solid with volume ≈ area × t', thick && hasSolid(thick) && near(properties(thick).volume, properties(e1).area * 2, properties(e1).area * 0.15), thick && properties(thick).volume.toFixed(1));

// --- skin (loft) through three open curves at different heights
r = await rebuild([
  sketch('a', at(0), [{ spline: [[-30, 0], [0, 10], [30, 0]] }]),
  sketch('b', at(20), [{ spline: [[-25, 0], [0, -6], [25, 0]] }]),
  sketch('c', at(40), [{ spline: [[-30, 0], [0, 12], [30, 0]] }]),
  { id: 'l1', type: 'surfloft', p: { sections: ['a', 'b', 'c'], ruled: false } },
]);
st = r.states.at(-1);
check('skin surface through 3 sections', !r.errors.l1 && st.bodies.has('l1') && !hasSolid(st.bodies.get('l1')), r.errors.l1);

// --- revolve an open profile into a vase surface, then patch the bottom with the base circle edge
r = await rebuild([
  sketch('v', XZ, [{ spline: [[10, 0], [16, 15], [9, 30], [12, 45]] }]),
  { id: 'rv', type: 'surfrevolve', p: { sketch: 'v', axis: 'sy', angle: 360 } },
]);
st = r.states.at(-1);
check('revolve surface', !r.errors.rv && st.bodies.has('rv'), r.errors.rv);

// --- rail surface: open profile swept along an arc-like spline rail
r = await rebuild([
  sketch('pr', XZ, [{ line: [[-5, 0], [5, 0]] }]),
  sketch('rl', XY, [{ spline: [[0, 0], [10, 20], [30, 30]] }]),
  { id: 'sw', type: 'surfsweep', p: { sketch: 'pr', path: 'rl', orient: 'frenet' } },
]);
check('rail surface', !r.errors.sw && r.states.at(-1).bodies.has('sw'), r.errors.sw);

// --- boundary patch over a closed non-planar loop of 4 curves? use one closed spline sketch (planar) + a circle
r = await rebuild([sketch('bd', at(5), [{ spline: [[-20, -10], [20, -15], [25, 15], [-15, 18]], closed: true }]), { id: 'pa', type: 'patch', p: { sections: ['bd'], edges: [], cont: 'G0' } }]);
st = r.states.at(-1);
check('boundary patch from closed curve', !r.errors.pa && st.bodies.has('pa') && properties(st.bodies.get('pa')).area > 500, r.errors.pa);

// --- offset surface of the extruded wave
r = await rebuild([sketch('s1', XY, [{ spline: wave }]), { id: 'e1', type: 'surfextrude', p: { sketch: 's1', side: 'one', distance: 25 } },
  { id: 'of', type: 'surfoffset', p: { faces: [{ body: 'e1', p: [-30, 0, 12.5] }], distance: 4 } }]);
check('offset surface', !r.errors.of && r.states.at(-1).bodies.has('of'), r.errors.of);

// --- stitch the 6 faces of an extruded square tube + 2 caps into a closed solid
r = await rebuild([
  sketch('sq', XY, [{ line: [[0, 0], [20, 0]] }, { line: [[20, 0], [20, 20]] }, { line: [[20, 20], [0, 20]] }, { line: [[0, 20], [0, 0]] }]),
  { id: 'tube', type: 'surfextrude', p: { sketch: 'sq', side: 'one', distance: 10 } },
  sketch('cap0', XY, [{ line: [[0, 0], [20, 0]] }, { line: [[20, 0], [20, 20]] }, { line: [[20, 20], [0, 20]] }, { line: [[0, 20], [0, 0]] }]),
  { id: 'pb', type: 'patch', p: { sections: ['cap0'], edges: [], cont: 'G0' } },
  sketch('cap1', at(10), [{ line: [[0, 0], [20, 0]] }, { line: [[20, 0], [20, 20]] }, { line: [[20, 20], [0, 20]] }, { line: [[0, 20], [0, 0]] }]),
  { id: 'pt', type: 'patch', p: { sections: ['cap1'], edges: [], cont: 'G0' } },
  { id: 'stt', type: 'stitch', p: { bodies: ['tube', 'pb', 'pt'], tolerance: 0.01 } },
]);
st = r.states.at(-1);
const box = st.bodies.get('tube');
check('stitch closes surfaces into a solid', !r.errors.stt && box && hasSolid(box) && near(Math.abs(properties(box).volume), 4000, 1), `${r.errors.stt || ''} ${box && properties(box).volume.toFixed(2)}`);

// --- curvature map: sphere of radius 10 → K = 0.01, H = 0.1 everywhere
r = await rebuild([{ id: 'sp', type: 'sphere', p: { r: 10, x: 0, y: 0, z: 0, op: 'new' } }]);
st = r.states.at(-1);
const sph = st.bodies.get('sp');
const field = curvatureField(sph);
let okK = true, okH = true;
for (let i = 0; i < field.length; i += 2) { if (!near(field[i], 0.01, 1e-4)) okK = false; if (!near(field[i + 1], 0.1, 1e-3)) okH = false; }
check('sphere Gaussian curvature = 1/r²', okK, `${field[0]}`);
check('sphere mean curvature = +1/r (convex positive)', okH, `${field[1]}`);
check('curvature field size matches mesh', field.length === (meshShape(sph).mesh.vertices.length / 3) * 2);

// cylinder r=15: K = 0, H = 1/30
r = await rebuild([{ id: 'cy', type: 'cylinder', p: { r: 15, h: 20, axis: 'Z', x: 0, y: 0, z: 0, op: 'new' } }]);
st = r.states.at(-1);
const cf = curvatureField(st.bodies.get('cy'));
let maxH = 0;
for (let i = 1; i < cf.length; i += 2) maxH = Math.max(maxH, cf[i]);
check('cylinder mean curvature = 1/(2r)', near(maxH, 1 / 30, 1e-4), String(maxH));

// --- curvature comb on the circular top edge: κ = 1/15 everywhere
const combs = curvatureCombs(st, [{ body: 'cy', p: [15, 0, 20] }]);
check('comb on circle edge has κ = 1/r', combs[0].k.every((k) => near(k, 1 / 15, 1e-6)), String(combs[0].k[0]));
check('comb normals point to the centre', near(combs[0].n[0][0] * combs[0].pts[0][0] + combs[0].n[0][1] * combs[0].pts[0][1], -15, 1e-3));

// ---------- free-form NURBS ----------
// 3D CV curve (non-planar)
r = await rebuild([{ id: 'cc', type: 'cvcurve', p: { cvs: [[0, 0, 0], [10, 10, 5], [20, -5, 10], [30, 5, 0], [40, 0, 5]], degree: '3', closed: false } }]);
st = r.states.at(-1);
check('CV curve builds', !r.errors.cc && st.curves.has('cc'), r.errors.cc);
check('CV curve length ≈ 45', st.curves.get('cc') && near(st.curves.get('cc').wire.edges[0].length, 44.98, 0.05), st.curves.get('cc')?.wire.edges[0].length);
const cvA = { id: 'ca', type: 'cvcurve', p: { cvs: [[-30, 0, 0], [-10, 0, 12], [10, 0, -6], [30, 0, 4]], degree: '3' } };
const cvB = { id: 'cb', type: 'cvcurve', p: { cvs: [[-30, 30, 5], [-10, 30, 0], [10, 30, 15], [30, 30, 2]], degree: '3' } };
r = await rebuild([cvA, cvB, { id: 'sk2', type: 'surfloft', p: { sections: ['ca', 'cb'], ruled: false } }]);
check('skin through two 3D CV curves', !r.errors.sk2 && r.states.at(-1).bodies.has('sk2'), r.errors.sk2);
r = await rebuild([cvA, { id: 'ex3', type: 'surfextrude', p: { sketch: 'ca', side: 'one', dir: 'Y', distance: 20 } }]);
check('extrude a 3D CV curve along Y', !r.errors.ex3 && properties(r.states.at(-1).bodies.get('ex3')).area > 60 * 20, r.errors.ex3);
r = await rebuild([{ id: 'cl', type: 'cvcurve', p: { cvs: [[0, 0, 0], [20, 0, 5], [20, 20, 0], [0, 20, 5]], degree: '3', closed: true } }]);
check('closed (periodic) CV curve', !r.errors.cl && r.states.at(-1).curves.has('cl'), r.errors.cl);

// CV surface: flat CV plane, then pull the centre CV up
const cvPlane = (extra = {}) => ({ id: 'cs', type: 'cvsurface', p: { source: 'plane', plane: { type: 'std', name: 'XY' }, w: 60, l: 60, nu: 5, nv: 5, degree: '3', ...extra } });
r = await rebuild([cvPlane()]);
st = r.states.at(-1);
const flatA = properties(st.bodies.get('cs')).area;
check('CV plane builds as 60×60 surface', !r.errors.cs && near(flatA, 3600, 1), flatA);
const grid = st.cvgrids.get('cs');
check('CV plane reports a 5×5 grid', grid && grid.nu === 5 && grid.nv === 5 && grid.poles.length === 25);
const poles = grid.poles.map((q) => q.slice());
poles[12][2] = 20;
r = await rebuild([cvPlane({ cv: { nu: 5, nv: 5, du: 3, dv: 3, poles } })]);
st = r.states.at(-1);
const bb = st.bodies.get('cs').boundingBox.bounds;
check('pulling a CV raises the surface', !r.errors.cs && bb[1][2] > 3 && properties(st.bodies.get('cs')).area > flatA + 20, `${bb[1][2]?.toFixed(2)} ${properties(st.bodies.get('cs')).area.toFixed(0)}`);
r = await rebuild([cvPlane({ nu: 6, cv: { nu: 5, nv: 5, du: 3, dv: 3, poles } })]);
check('changing the CV count resets edits', near(properties(r.states.at(-1).bodies.get('cs')).area, 3600, 1));

// rebuild a skinned face as a CV surface
r = await rebuild([cvA, cvB, { id: 'l1', type: 'surfloft', p: { sections: ['ca', 'cb'], ruled: false } },
  { id: 'rb', type: 'cvsurface', p: { source: 'face', method: 'fit', face: [{ body: 'l1', p: [-30, 0, 0] }], replace: true, nu: 6, nv: 6, degree: '3' } },
]);
st = r.states.at(-1);
check('rebuild face as CV surface (6×6, replaces original)', !r.errors.rb && st.cvgrids.get('rb')?.nu === 6 && !st.bodies.has('l1'), `${r.errors.rb} nu=${st.cvgrids.get('rb')?.nu} l1=${st.bodies.has('l1')}`);

// surface fillet between a floor and a wall (quarter-cylinder blend)
const floor = sketch('fl', XY, [{ line: [[-30, -30], [30, -30]] }]);
const wallS = sketch('wl', { origin: [0, 0, -10], xDir: [1, 0, 0], normal: [0, 0, 1] }, [{ line: [[0, -30], [0, 30]] }]);
r = await rebuild([floor, { id: 'F', type: 'surfextrude', p: { sketch: 'fl', side: 'one', dir: 'Y', distance: 60 } }, wallS, { id: 'W', type: 'surfextrude', p: { sketch: 'wl', side: 'one', distance: 30 } },
  { id: 'sf', type: 'surffillet', p: { a: [{ body: 'F', p: [-20, 0, 0] }], b: [{ body: 'W', p: [0, 0, 15] }], radius: 5 } }]);
st = r.states.at(-1);
const filleted = st.bodies.get('F');
check('surface fillet builds a single sewn surface', !r.errors.sf && filleted && filleted.faces.length === 3 && !st.bodies.has('W'), r.errors.sf || filleted?.faces.length);
check('surface fillet area = trimmed floor + trimmed wall + quarter cylinder', filleted && near(properties(filleted).area, 25 * 60 + 15 * 60 + (Math.PI / 2) * 5 * 60, 2), filleted && properties(filleted).area.toFixed(2));

// trim a surface with a closed sketch curve (cut a square window)
r = await rebuild([sketch('pl', XY, [{ line: [[-30, -30], [30, -30]] }]), { id: 'P', type: 'surfextrude', p: { sketch: 'pl', side: 'one', dir: 'Y', distance: 60 } },
  sketch('win', at(10), [{ line: [[-10, -10], [10, -10]] }, { line: [[10, -10], [10, 10]] }, { line: [[10, 10], [-10, 10]] }, { line: [[-10, 10], [-10, -10]] }]),
  { id: 'tr', type: 'surftrim', p: { target: [{ body: 'P', p: [0, 0, 0] }], sketch: 'win', mode: 'remove', dir: 'Z' } }]);
st = r.states.at(-1);
check('trim removes the window region', !r.errors.tr && near(properties(st.bodies.get('P')).area, 3600 - 400, 1), r.errors.tr || properties(st.bodies.get('P')).area);
r = await rebuild([sketch('pl', XY, [{ line: [[-30, -30], [30, -30]] }]), { id: 'P', type: 'surfextrude', p: { sketch: 'pl', side: 'one', dir: 'Y', distance: 60 } },
  sketch('cut', at(10), [{ spline: [[-40, -5], [0, 12], [40, -5]] }]),
  { id: 'tr', type: 'surftrim', p: { target: [{ body: 'P', p: [0, -20, 0] }], sketch: 'cut', mode: 'keep', dir: 'Z' } }]);
st = r.states.at(-1);
const ta = properties(st.bodies.get('P')).area;
check('trim by an open curve keeps the clicked side', !r.errors.tr && ta > 1000 && ta < 2600, r.errors.tr || ta.toFixed(0));

// ---------- variable-radius surface fillet (3 → 8 mm along the 60 mm edge) ----------
r = await rebuild([floor, { id: 'F', type: 'surfextrude', p: { sketch: 'fl', side: 'one', dir: 'Y', distance: 60 } }, wallS, { id: 'W', type: 'surfextrude', p: { sketch: 'wl', side: 'one', distance: 30 } },
  { id: 'vf', type: 'surffillet', p: { a: [{ body: 'F', p: [-20, 0, 0] }], b: [{ body: 'W', p: [0, 0, 15] }], rmode: 'variable', radius: 3, radius2: 8, flip: false } }]);
st = r.states.at(-1);
const vfa = st.bodies.get('F') && properties(st.bodies.get('F')).area;
const mean = 5.5, expV = (30 - mean) * 60 + (20 - mean) * 60 + (Math.PI / 2) * mean * 60;
check('variable-radius fillet builds and sews', !r.errors.vf && st.bodies.get('F')?.faces.length === 3, r.errors.vf || r.warnings.vf);
check('variable-radius fillet area matches the radius law', vfa && near(vfa, expV, 6), `${vfa?.toFixed(1)} vs ${expV.toFixed(1)}`);
const fb = st.bodies.get('F').faces.map((x) => x.boundingBox.bounds);
const blend = fb.find((b) => b[1][0] - b[0][0] < 9 && b[1][2] - b[0][2] < 9 && b[1][1] - b[0][1] > 50);
check('fillet grows from 3 to 8 mm', !!blend && near(Math.max(...fb.map((b) => b[1][0] - b[0][0]).filter((w) => w < 9)), 8, 0.3), JSON.stringify(blend));

// ---------- trim along the view direction ----------
r = await rebuild([sketch('pl', XY, [{ line: [[-30, -30], [30, -30]] }]), { id: 'P', type: 'surfextrude', p: { sketch: 'pl', side: 'one', dir: 'Y', distance: 60 } },
  sketch('win', at(10), [{ line: [[-10, -10], [10, -10]] }, { line: [[10, -10], [10, 10]] }, { line: [[10, 10], [-10, 10]] }, { line: [[-10, 10], [-10, -10]] }]),
  { id: 'tv', type: 'surftrim', p: { target: [{ body: 'P', p: [0, 0, 0] }], sketch: 'win', mode: 'remove', dir: 'view', viewDir: [0.6, 0, -0.8] } }]);
st = r.states.at(-1);
check('trim along an oblique view direction', !r.errors.tv && near(properties(st.bodies.get('P')).area, 3600 - 400, 1), r.errors.tv || properties(st.bodies.get('P')).area);
const winFace = st.bodies.get('P');
const wb = winFace.boundingBox.bounds;
check('oblique projection shifts the window', !!wb, '');

// ---------- exact rebuild ----------
r = await rebuild([cvA, cvB, { id: 'l1', type: 'surfloft', p: { sections: ['ca', 'cb'], ruled: false } },
  { id: 'ex', type: 'cvsurface', p: { source: 'face', method: 'exact', face: [{ body: 'l1', p: [-30, 0, 0] }], replace: false } }]);
st = r.states.at(-1);
const exg = st.cvgrids.get('ex');
check('exact rebuild keeps the original NURBS', !r.errors.ex && exg?.exact && near(properties(st.bodies.get('ex')).area, properties(st.bodies.get('l1')).area, 1e-6), `${r.errors.ex} ${exg?.nu}x${exg?.nv}`);
// edit one exact CV and the surface moves; the knot vectors are kept
const ep = exg.poles.map((q) => q.slice()); ep[1][2] += 10;
r = await rebuild([cvA, cvB, { id: 'l1', type: 'surfloft', p: { sections: ['ca', 'cb'], ruled: false } },
  { id: 'ex', type: 'cvsurface', p: { source: 'face', method: 'exact', face: [{ body: 'l1', p: [-30, 0, 0] }], replace: false, cv: { ...exg, poles: ep, edited: true } } }]);
st = r.states.at(-1);
check('editing an exact CV surface changes its shape', !r.errors.ex && Math.abs(properties(st.bodies.get('ex')).area - properties(st.bodies.get('l1')).area) > 1, r.errors.ex);

// exact rebuild of a trimmed planar face keeps the trim (window) through an edit
const trimmedPlane = [sketch('pl', XY, [{ line: [[-30, -30], [30, -30]] }]), { id: 'P', type: 'surfextrude', p: { sketch: 'pl', side: 'one', dir: 'Y', distance: 60 } },
  sketch('win', at(10), [{ line: [[-10, -10], [10, -10]] }, { line: [[10, -10], [10, 10]] }, { line: [[10, 10], [-10, 10]] }, { line: [[-10, 10], [-10, -10]] }]),
  { id: 'tr', type: 'surftrim', p: { target: [{ body: 'P', p: [0, 0, 0] }], sketch: 'win', mode: 'remove', dir: 'Z' } }];
r = await rebuild([...trimmedPlane, { id: 'rp', type: 'cvsurface', p: { source: 'face', method: 'exact', face: [{ body: 'P', p: [-20, -20, 0] }], replace: true } }]);
st = r.states.at(-1);
const rpg = st.cvgrids.get('rp');
check('exact rebuild of a trimmed face records its trim loops', !r.errors.rp && rpg?.trims?.length === 2, `${r.errors.rp} loops=${rpg?.trims?.length}`);
r = await rebuild([...trimmedPlane, { id: 'rp', type: 'cvsurface', p: { source: 'face', method: 'exact', face: [{ body: 'P', p: [-20, -20, 0] }], replace: true, cv: { ...rpg, edited: true } } }]);
st = r.states.at(-1);
check('trimmed CV surface keeps the window after an edit', !r.errors.rp && near(properties(st.bodies.get('rp')).area, 3200, 0.5), r.errors.rp || properties(st.bodies.get('rp')).area);
// refit (approximate) also keeps the trim, and reports no deviation warning for a plane
r = await rebuild([...trimmedPlane, { id: 'rf', type: 'cvsurface', p: { source: 'face', method: 'fit', face: [{ body: 'P', p: [-20, -20, 0] }], replace: true, nu: 5, nv: 5, degree: '3' } }]);
st = r.states.at(-1);
check('refit keeps trims too', !r.errors.rf && near(properties(st.bodies.get('rf')).area, 3200, 2), r.errors.rf || properties(st.bodies.get('rf')).area);
// refit of a sphere reports its deviation honestly
r = await rebuild([{ id: 'sp', type: 'sphere', p: { r: 10, x: 0, y: 0, z: 0, op: 'new' } },
  { id: 'rs', type: 'cvsurface', p: { source: 'face', method: 'fit', face: [{ body: 'sp', p: [10, 0, 0] }], replace: false, nu: 4, nv: 4, degree: '3' } }]);
check('coarse refit warns with its deviation', !r.errors.rs && /deviates/.test(r.warnings.rs || ''), r.errors.rs || r.warnings.rs);

// ---------- fillet size laws and chord-length sizing ----------
const filletArea = async (fp) => {
  const rr = await rebuild([floor, { id: 'F', type: 'surfextrude', p: { sketch: 'fl', side: 'one', dir: 'Y', distance: 60 } }, wallS, { id: 'W', type: 'surfextrude', p: { sketch: 'wl', side: 'one', distance: 30 } },
    { id: 'lf', type: 'surffillet', p: { a: [{ body: 'F', p: [-25, 0, 0] }], b: [{ body: 'W', p: [0, 0, 18] }], ...fp } }]);
  const b = rr.states.at(-1).bodies.get('F');
  return { err: rr.errors.lf, area: b ? properties(b).area : NaN, faces: b?.faces.length };
};
const areaFor = (m) => (30 - m) * 60 + (20 - m) * 60 + (Math.PI / 2) * m * 60;
let fr = await filletArea({ size: 'chord', rmode: 'constant', radius: 5 * Math.SQRT2 });
check('chord-length fillet: chord 5√2 on a 90° corner = radius 5', !fr.err && near(fr.area, areaFor(5), 2), fr.err || `${fr.area.toFixed(2)} vs ${areaFor(5).toFixed(2)}`);
fr = await filletArea({ rmode: 'variable', law: 'smooth', radius: 3, radius2: 8 });
check('smooth (S-curve) radius law', !fr.err && near(fr.area, areaFor(5.5), 6), fr.err || `${fr.area.toFixed(1)} vs ${areaFor(5.5).toFixed(1)}`);
fr = await filletArea({ rmode: 'variable', law: 'mid', radius: 3, radiusMid: 8, radius2: 3 });
const meanMid = 3 / 6 + (8 * 2) / 3 + 3 / 6;
check('curved radius profile through a middle value', !fr.err && fr.faces === 3 && near(fr.area, areaFor(meanMid), 8), fr.err || `${fr.area.toFixed(1)} vs ${areaFor(meanMid).toFixed(1)}`);

// ---------- exact trim segments: a round hole survives a CV edit exactly ----------
const holed = [sketch('pl', XY, [{ line: [[-30, -30], [30, -30]] }]), { id: 'P', type: 'surfextrude', p: { sketch: 'pl', side: 'one', dir: 'Y', distance: 60 } },
  sketch('hole', at(10), [{ circle: [[0, 0], 10] }]),
  { id: 'th', type: 'surftrim', p: { target: [{ body: 'P', p: [-20, -20, 0] }], sketch: 'hole', mode: 'keep', dir: 'Z' } }];
r = await rebuild([...holed, { id: 'rh', type: 'cvsurface', p: { source: 'face', method: 'exact', face: [{ body: 'P', p: [-20, -20, 0] }], replace: true } }]);
st = r.states.at(-1);
const hg = st.cvgrids.get('rh');
const segTypes = (hg?.trims || []).flat().map((x) => x.t).sort().join(',');
check('trim loops use exact line and arc segments', segTypes.includes('arc') && segTypes.includes('line') && !segTypes.includes('pts'), segTypes);
r = await rebuild([...holed, { id: 'rh', type: 'cvsurface', p: { source: 'face', method: 'exact', face: [{ body: 'P', p: [-20, -20, 0] }], replace: true, cv: { ...hg, edited: true } } }]);
st = r.states.at(-1);
const holeEdges = st.bodies.get('rh')?.edges.filter((x) => x.length < 40) || [];
check('round hole edges are exact after an edit (2 × 10π)', !r.errors.rh && holeEdges.length === 2 && holeEdges.every((x) => near(x.length, Math.PI * 10, 1e-6)), r.errors.rh || holeEdges.map((x) => x.length).join(','));
check('round hole area after an edit (3600 − 100π, numeric integration)', !r.errors.rh && near(properties(st.bodies.get('rh')).area, 3600 - Math.PI * 100, 0.1), r.errors.rh);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

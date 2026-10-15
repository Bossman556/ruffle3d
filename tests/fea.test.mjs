// Stress analysis: element stiffness sanity, voxelisation and a cantilever against beam theory.
import { hexStiffness, voxelize, solveStatic, refineMesh } from '../src/fea.js';

let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };

// box mesh with one face group per side: 0 x-, 1 x+, 2 y-, 3 y+, 4 z-, 5 z+ (outward-wound)
function boxMesh(L, W, H) {
  const P = [], I = [], groups = [];
  const quad = (a, b, c, d) => { const s = P.length / 3; P.push(...a, ...b, ...c, ...d); groups.push({ start: I.length, count: 6 }); I.push(s, s + 1, s + 2, s, s + 2, s + 3); };
  quad([0, 0, 0], [0, 0, H], [0, W, H], [0, W, 0]);
  quad([L, 0, 0], [L, W, 0], [L, W, H], [L, 0, H]);
  quad([0, 0, 0], [L, 0, 0], [L, 0, H], [0, 0, H]);
  quad([0, W, 0], [0, W, H], [L, W, H], [L, W, 0]);
  quad([0, 0, 0], [0, W, 0], [L, W, 0], [L, 0, 0]);
  quad([0, 0, H], [L, 0, H], [L, W, H], [0, W, H]);
  return { positions: new Float32Array(P), index: new Uint32Array(I), faceGroups: groups };
}

const K = hexStiffness(0.3);
let sym = 0, rowSum = 0;
for (let a = 0; a < 24; a++) for (let b = 0; b < 24; b++) sym = Math.max(sym, Math.abs(K[a * 24 + b] - K[b * 24 + a]));
for (let a = 0; a < 24; a++) { let s = 0; for (let c = 0; c < 8; c++) s += K[a * 24 + c * 3]; rowSum = Math.max(rowSum, Math.abs(s)); }
check('element stiffness is symmetric', sym < 1e-12, sym.toExponential(2));
check('rigid translation gives no force', rowSum < 1e-12, rowSum.toExponential(2));

const box = boxMesh(100, 10, 10);
const vox = voxelize(box.positions, box.index, 2.5);
const nsolid = vox.solid.reduce((a, b) => a + b, 0);
check('voxelises a 100×10×10 bar into 40×4×4 cells', nsolid === 640, `${nsolid}`);

// cantilever: steel, fixed at x = 0, 100 N downward on the free end
const E = 200000, F = 100, L = 100, b = 10, h = 10, I = (b * h ** 3) / 12;
const theory = (F * L ** 3) / (3 * E * I) + (F * L) / ((5 / 6) * (E / 2.6) * b * h); // bending + shear
const t0 = Date.now();
const r = solveStatic({ ...box, E, nu: 0.3, elements: 640, fixed: [0], loads: [{ faces: [1], type: 'force', value: F, dir: [0, 0, -1] }] });
check('solver converges', r.converged, `${r.iterations} iterations, ${Date.now() - t0} ms`);
check('applied force is 100 N downward', Math.abs(r.appliedForce[2] + F) < 1e-6 && Math.abs(r.appliedForce[0]) < 1e-9, JSON.stringify(r.appliedForce.map((v) => +v.toFixed(6))));
check('tip deflection within 6% of beam theory', Math.abs(r.maxDisplacement - theory) / theory < 0.06, `${r.maxDisplacement.toFixed(4)} mm vs ${theory.toFixed(4)} mm`);
const sigma = (F * L * (h / 2)) / I; // 60 MPa at the root
check('peak bending stress within 15% of 60 MPa', Math.abs(r.maxVonMises - sigma) / sigma < 0.15, `${r.maxVonMises.toFixed(1)} MPa`);
const finer = solveStatic({ ...box, E, nu: 0.3, elements: 5120, fixed: [0], loads: [{ faces: [1], type: 'force', value: F, dir: [0, 0, -1] }] });
check('refined mesh agrees on deflection (within 3%)', Math.abs(finer.maxDisplacement - theory) / theory < 0.03, `${finer.maxDisplacement.toFixed(4)} mm, ${finer.elements} elements, ${finer.iterations} it`);

// axial pressure on the end face: σ = p, δ = pL/E
const pr = solveStatic({ ...box, E, nu: 0.3, elements: 640, fixed: [0], loads: [{ faces: [1], type: 'pressure', value: -10 }] });
const dAx = (10 * L) / E;
check('tension by pressure: elongation p·L/E', Math.abs(pr.maxDisplacement - dAx) / dAx < 0.15, `${pr.maxDisplacement.toExponential(3)} vs ${dAx.toExponential(3)}`);

// peak away from the support ignores the singular corners at the fixed face
const fine = solveStatic({ ...box, E, nu: 0.3, elements: 20000, fixed: [0], loads: [{ faces: [1], type: 'force', value: F, dir: [0, 0, -1] }] });
check('peak stress away from supports ≈ beam theory', Math.abs(fine.maxAwayFromSupports - sigma) / sigma < 0.12 && fine.maxVonMises >= fine.maxAwayFromSupports, `${fine.maxAwayFromSupports.toFixed(1)} MPa (at supports ${fine.maxVonMises.toFixed(1)}), ${fine.iterations} it`);
check('multigrid keeps iterations low', fine.iterations < 80, `${fine.iterations}`);

// display mesh refinement keeps face groups and area
const nrm = new Float32Array(box.positions.length);
const ref = refineMesh(box.positions, nrm, box.index, box.faceGroups, 5);
let area = 0;
for (let t = 0; t < ref.index.length / 3; t++) {
  const [a, b, c] = [0, 1, 2].map((k) => ref.index[t * 3 + k] * 3);
  const u = [0, 1, 2].map((k) => ref.positions[b + k] - ref.positions[a + k]), v = [0, 1, 2].map((k) => ref.positions[c + k] - ref.positions[a + k]);
  area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
}
const lastG = ref.faceGroups.at(-1);
check('refined display mesh keeps the area and face groups', Math.abs(area - (2 * 100 * 10 * 2 + 2 * 10 * 10)) < 1e-2 && lastG.start + lastG.count === ref.index.length && ref.faceGroups.length === 6, `${area.toFixed(3)} mm², ${ref.index.length / 3} triangles`);

let err = '';
try { solveStatic({ ...box, E, nu: 0.3, elements: 640, fixed: [], loads: [{ faces: [1], type: 'force', value: 1, dir: 'normal' }] }); } catch (e) { err = e.message; }
check('missing constraint is explained', /fixed face/.test(err), err);

// gravity: the steel bar's own weight, ρVg = 7.85e-9 t/mm³ × 10 000 mm³ × 9810 mm/s² = 0.770 N, sags it
// like a cantilever with a uniform load: δ = wL⁴/(8EI) (plus a little shear)
{
  const W = 7.85e-9 * 100 * 10 * 10 * 9810, w = W / L;
  const grav = solveStatic({ ...box, E, nu: 0.3, density: 7.85, elements: 2560, fixed: [0], loads: [{ type: 'gravity', faces: [], value: 1, dir: [0, 0, -1] }] });
  const want = (w * L ** 4) / (8 * E * I);
  check('gravity applies the body weight', Math.abs(-grav.appliedForce[2] - W) / W < 1e-9, `${(-grav.appliedForce[2]).toFixed(4)} N vs ${W.toFixed(4)} N`);
  check('self-weight sag matches beam theory within 8%', Math.abs(grav.maxDisplacement - want) / want < 0.08, `${grav.maxDisplacement.toExponential(3)} vs ${want.toExponential(3)} mm`);
  const g3 = solveStatic({ ...box, E, nu: 0.3, density: 7.85, elements: 2560, fixed: [0], loads: [{ type: 'gravity', faces: [], value: 3, dir: [0, 0, -1] }] });
  check('a 3 g load is three times the weight', Math.abs(g3.maxDisplacement / grav.maxDisplacement - 3) < 1e-6);
}
// bearing load: pushing down on all four long faces, only the faces that face the push (the top) carry it,
// so it equals a plain 100 N force spread on the top face
{
  const bear = solveStatic({ ...box, E, nu: 0.3, elements: 640, fixed: [0], loads: [{ type: 'bearing', faces: [2, 3, 4, 5], value: F, dir: [0, 0, -1] }] });
  const plain = solveStatic({ ...box, E, nu: 0.3, elements: 640, fixed: [0], loads: [{ type: 'force', faces: [5], value: F, dir: [0, 0, -1] }] });
  check('bearing load totals the force along its direction', Math.abs(bear.appliedForce[2] + F) < 1e-6 && Math.abs(bear.appliedForce[0]) < 1e-9 && Math.abs(bear.appliedForce[1]) < 1e-9, JSON.stringify(bear.appliedForce.map((v) => +v.toFixed(6))));
  check('only the side facing the push is loaded', Math.abs(bear.maxDisplacement - plain.maxDisplacement) / plain.maxDisplacement < 1e-6, `${bear.maxDisplacement.toFixed(5)} vs ${plain.maxDisplacement.toFixed(5)}`);
}

// linear buckling: a 10 × 10 × 100 steel column, fixed at one end, pushed along its axis at the other.
// Euler (fixed–free): P_cr = π² E I / (4 L²) = 41.1 kN; with 1 kN applied the load factor is ≈ 41.
{
  const { solveBuckling } = await import('../src/fea.js');
  const Ib = 1e4 / 12, Pcr = (Math.PI ** 2 * E * Ib) / (4 * 100 ** 2);
  const t0 = performance.now();
  const bk = solveBuckling({ ...box, E, nu: 0.3, elements: 5120, fixed: [0], loads: [{ faces: [1], type: 'force', value: 1000, dir: [-1, 0, 0] }], modes: 2 });
  const f1 = bk.modes[0].factor;
  check('buckling load factor of a fixed–free column matches Euler within 8%', Math.abs(f1 * 1000 - Pcr) / Pcr < 0.08, `λ = ${f1.toFixed(2)} → ${(f1).toFixed(1)} kN vs ${(Pcr / 1000).toFixed(1)} kN, ${bk.iterations} iterations, ${Math.round(performance.now() - t0)} ms`);
  check('the square column has two equal first modes (it can buckle either way)', bk.modes.length === 2 && Math.abs(bk.modes[1].factor - f1) / f1 < 0.03, bk.modes.map((m) => m.factor.toFixed(2)).join(', '));
  let err = '';
  try { solveBuckling({ ...box, E, nu: 0.3, elements: 640, fixed: [0], loads: [{ faces: [1], type: 'force', value: 1000, dir: [1, 0, 0] }], modes: 1 }); } catch (e) { err = e.message; }
  check('a column pulled in tension does not buckle', /cannot buckle/.test(err) || err === '', err);
}

// plasticity: the 100 × 10 × 10 cantilever (σy = 250 MPa). First yield at M = σy·b h²/6 → F = 41.7 N·m / L;
// full plastic collapse at 1.5 × that (rectangular section).
{
  const { solvePlastic } = await import('../src/fea.js');
  const Fy = (250 * 10 * 100) / 6 / 100; // 416.7 N
  const el = solvePlastic({ ...box, E, nu: 0.3, elements: 2560, yield: 250, fixed: [0], loads: [{ faces: [1], type: 'force', value: 0.5 * Fy, dir: [0, 0, -1] }] });
  check('below yield the plastic solution is the linear one', el.maxPlasticStrain < 1e-6 && el.plasticFraction === 0 && Math.abs(el.maxDisplacement - el.linearDisplacement) < 1e-9, `${el.iterations} it`);
  const pl = solvePlastic({ ...box, E, nu: 0.3, elements: 2560, yield: 250, hardening: 0.01, fixed: [0], loads: [{ faces: [1], type: 'force', value: 1.4 * Fy, dir: [0, 0, -1] }] });
  check('past first yield the root yields, the stress is capped near σy and it deflects more than linear', !pl.collapsed && pl.converged && pl.plasticFraction > 0 && pl.maxVonMises < 250 * 1.1 && pl.maxDisplacement > 1.03 * pl.linearDisplacement, `σmax ${pl.maxVonMises.toFixed(0)} MPa, εp ${(pl.maxPlasticStrain * 100).toFixed(3)}%, δ ${pl.maxDisplacement.toFixed(3)} vs linear ${pl.linearDisplacement.toFixed(3)} mm, ${(pl.plasticFraction * 100).toFixed(1)}% yielded, ${pl.iterations} it`);
  const co = solvePlastic({ ...box, E, nu: 0.3, elements: 2560, yield: 250, hardening: 0.0001, fixed: [0], loads: [{ faces: [1], type: 'force', value: 2.2 * Fy, dir: [0, 0, -1] }] });
  check('well past the plastic collapse load the part is reported as collapsing', co.collapsed || co.maxDisplacement > 8 * co.linearDisplacement, `collapsed ${co.collapsed}, δ ${co.maxDisplacement.toFixed(2)} vs ${co.linearDisplacement.toFixed(2)}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

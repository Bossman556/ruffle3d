// Steady-state heat conduction against 1-D hand calculations.
import { solveThermal } from '../src/fea.js';

let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
function boxMesh(L, W, H) {
  const P = [], I = [], groups = [];
  const quad = (a, b, c, d) => { const s = P.length / 3; P.push(...a, ...b, ...c, ...d); groups.push({ start: I.length, count: 6 }); I.push(s, s + 1, s + 2, s, s + 2, s + 3); };
  quad([0, 0, 0], [0, 0, H], [0, W, H], [0, W, 0]); // 0: x = 0
  quad([L, 0, 0], [L, W, 0], [L, W, H], [L, 0, H]); // 1: x = L
  quad([0, 0, 0], [L, 0, 0], [L, 0, H], [0, 0, H]);
  quad([0, W, 0], [0, W, H], [L, W, H], [L, W, 0]);
  quad([0, 0, 0], [0, W, 0], [L, W, 0], [L, 0, 0]);
  quad([0, 0, H], [L, 0, H], [L, W, H], [0, W, H]);
  return { positions: new Float32Array(P), index: new Uint32Array(I), faceGroups: groups };
}
const bar = boxMesh(100, 10, 10), k = 167, A = 100, L = 100;

// fixed temperatures at both ends: linear profile, Q = k A ΔT / L
let r = solveThermal({ ...bar, k, elements: 4000, loads: [{ faces: [0], type: 'temp', value: 100 }, { faces: [1], type: 'temp', value: 20 }] });
check('solver converges', r.converged, `${r.iterations} iterations`);
check('temperatures stay between the two fixed values', Math.abs(r.tMax - 100) < 1e-6 && Math.abs(r.tMin - 20) < 1e-6, `${r.tMin.toFixed(3)} … ${r.tMax.toFixed(3)}`);
// sample temperature at vertices: the bar mesh only has end vertices, so check the midpoint via a refined display mesh
const nrm = new Float32Array(bar.positions.length);
r = solveThermal({ ...bar, normals: nrm, k, elements: 4000, loads: [{ faces: [0], type: 'temp', value: 100 }, { faces: [1], type: 'temp', value: 20 }] });
let mid = null;
for (let v = 0; v < r.display.positions.length / 3; v++) if (Math.abs(r.display.positions[v * 3] - 50) < 0.6) { mid = r.temperature[v]; break; }
check('mid-length temperature is 60 °C', mid != null && Math.abs(mid - 60) < 1, `${mid?.toFixed(2)} °C`);

// 10 W into the free end, the other end held at 20 °C: T_end = 20 + P L / (k A)
r = solveThermal({ ...bar, k, elements: 4000, loads: [{ faces: [1], type: 'heat', value: 10 }, { faces: [0], type: 'temp', value: 20 }] });
const tEnd = 20 + (10 * L) / ((k / 1000) * A);
check('heated end reaches 20 + PL/kA', Math.abs(r.tMax - tEnd) / (tEnd - 20) < 0.05, `${r.tMax.toFixed(2)} vs ${tEnd.toFixed(2)} °C`);
check('heat balance: power in = heat out through the fixed face', Math.abs(r.power - 10) < 1e-6 && Math.abs(-r.reaction - 10) < 0.05, `in ${r.power.toFixed(3)} W, out ${(-r.reaction).toFixed(3)} W`);

// convection only: a plate heated with 5 W, cooled by h = 25 W/m²K over all faces → T ≈ T∞ + P / (h A)
const plate = boxMesh(80, 80, 4);
const area = 2 * 80 * 80 + 4 * 80 * 4;
r = solveThermal({ ...plate, k: 200, elements: 6000, loads: [{ faces: [5], type: 'heat', value: 5 }, { faces: [0, 1, 2, 3, 4, 5], type: 'conv', value: 25, ambient: 20 }] });
const tc = 20 + 5 / ((25 / 1e6) * area);
check('convection-cooled plate settles at T∞ + P/(hA)', Math.abs((r.tMin + r.tMax) / 2 - tc) / (tc - 20) < 0.05, `${r.tMin.toFixed(2)} … ${r.tMax.toFixed(2)} vs ${tc.toFixed(2)} °C`);

let err = '';
try { solveThermal({ ...bar, k, loads: [{ faces: [1], type: 'heat', value: 1 }] }); } catch (e) { err = e.message; }
check('heat with nowhere to go is explained', /somewhere to go/.test(err), err);

// transient: an aluminium cube starting at 100 °C cools by convection (h = 50 W/m²K) towards 20 °C.
// Biot number ≪ 1, so the lumped solution T = 20 + 80 exp(-t/τ), τ = ρ c V / (h A), applies.
{
  const cube = boxMesh(20, 20, 20), rho = 2.7, cp = 900, hc = 50;
  const V = 8000, Acube = 6 * 400, tau = (rho * 1e-6 * cp * V) / ((hc / 1e6) * Acube);
  const tr = solveThermal({ ...cube, k: 167, density: rho, cp, elements: 3000, transient: { duration: tau, steps: 100, initial: 100 }, loads: [{ faces: [0, 1, 2, 3, 4, 5], type: 'conv', value: hc, ambient: 20 }] });
  const end = tr.history.at(-1), exact = 20 + 80 * Math.exp(-1);
  check('transient: a cooling block follows the lumped exponential after one time constant', Math.abs(end.mean - exact) < 1.2, `${end.mean.toFixed(2)} vs ${exact.toFixed(2)} °C at t = τ = ${tau.toFixed(0)} s`);
  check('transient: temperatures fall steadily and frames are recorded', tr.history.every((h, i) => !i || h.mean <= tr.history[i - 1].mean + 1e-9) && tr.frames.length >= 10, `${tr.frames.length} frames`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

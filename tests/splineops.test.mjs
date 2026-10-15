// Spline trim and offset in sketches.
import { catmullBeziers } from '../src/sketch/model.js';
import { splineSamples, fitPointLengths, splineCrossings, trimSplinePieces, splineSide, offsetSplinePoints } from '../src/sketch/splineops.js';

let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const spline = (pts, closed = false) => ({ type: 'spline', pts, closed, bez: catmullBeziers(pts, closed) });
const line = (a, b) => ({ type: 'line', a, b });

// an open wave through 5 points, crossed by vertical lines at x = 15 and x = 25
const wave = spline([[0, 0], [10, 5], [20, 0], [30, 5], [40, 0]]);
const S = splineSamples(wave);
const L = fitPointLengths(S, wave.bez.length), total = S[S.length - 1].s;
const xs = splineCrossings(S, [{ id: 'v1', g: line([15, -10], [15, 10]) }, { id: 'v2', g: line([25, -10], [25, 10]) }]);
check('the wave crosses each line once', xs.length === 2 && near(xs[0].p[0], 15, 1e-9) && near(xs[1].p[0], 25, 1e-9), JSON.stringify(xs.map((x) => x.p)));
const sMid = S.find((q) => q.span === 2 && q.u === 0).s; // at the fit point (20, 0)
const fit = wave.pts.map((xy, i) => ({ id: `p${i}`, xy }));
const pieces = trimSplinePieces(fit, L, false, xs, sMid, total);
check('trimming the middle keeps a piece on each side', pieces.length === 2, JSON.stringify(pieces));
check('the left piece keeps the first two fit points and ends at the cut on x = 15', pieces[0].pts.map((q) => q.id || 'cut').join() === 'p0,p1,cut' && near(pieces[0].pts[2].xy[0], 15, 1e-9) && pieces[0].pts[2].other === 'v1');
check('the right piece starts at the cut on x = 25 and keeps the last two fit points', pieces[1].pts.map((q) => q.id || 'cut').join() === 'cut,p3,p4' && near(pieces[1].pts[0].xy[0], 25, 1e-9) && pieces[1].pts[0].other === 'v2');
// clicking the end beyond the last crossing removes only that end
const end = trimSplinePieces(fit, L, false, xs, total - 0.5, total);
check('trimming an end keeps everything up to the last crossing', end.length === 1 && end[0].pts.map((q) => q.id || 'cut').join() === 'p0,p1,p2,cut', JSON.stringify(end[0].pts.map((q) => q.id || 'cut')));
check('a spline that crosses nothing is removed', trimSplinePieces(fit, L, false, [], sMid, total).length === 0);

// a closed loop (8 points on a circle of radius 10), cut by the x axis: clicking the top keeps the bottom
const ring = spline(Array.from({ length: 8 }, (_, i) => [10 * Math.cos((i * Math.PI) / 4 + 0.2), 10 * Math.sin((i * Math.PI) / 4 + 0.2)]), true);
const RS = splineSamples(ring), RL = fitPointLengths(RS, ring.bez.length);
const rx = splineCrossings(RS, [{ id: 'ax', g: line([-20, 0], [20, 0]) }]);
let top = 0, bd = Infinity;
for (const q of RS) { const d = Math.hypot(q.p[0], q.p[1] - 10); if (d < bd) { bd = d; top = q.s; } }
const kept = trimSplinePieces(ring.pts.map((xy, i) => ({ id: `r${i}`, xy })), RL, true, rx, top, RS[RS.length - 1].s);
const keptPts = kept[0]?.pts.map((q) => q.xy || ring.pts[+q.id.slice(1)]);
check('trimming the top of a closed loop leaves one open piece below the axis', rx.length === 2 && kept.length === 1 && keptPts.slice(1, -1).every((p) => p[1] < 0) && keptPts.length >= 4, JSON.stringify(keptPts?.map((p) => p.map((v) => +v.toFixed(2)))));

// offset: every point of the offset spline is the offset distance from the original
const dist = (p, samples) => Math.min(...samples.map((q) => Math.hypot(q.p[0] - p[0], q.p[1] - p[1])));
const side = splineSide(S, [20, -5]);
const off = spline(offsetSplinePoints(wave, 2 * side));
const OS = splineSamples(off, 16).slice(4, -4); // away from the open ends
const ds = OS.map((q) => dist(q.p, splineSamples(wave, 128)));
check('the side below the wave is the right-hand side', side === -1);
check('an offset spline stays the offset distance away (within 0.1)', Math.max(...ds.map((d) => Math.abs(d - 2))) < 0.1, `${Math.min(...ds).toFixed(3)} … ${Math.max(...ds).toFixed(3)}`);
check('it is on the side that was clicked', OS.every((q) => q.p[1] < 5));
const roff = spline(offsetSplinePoints(ring, 1.5), true); // the loop runs counter-clockwise, so its left is inside
const rr = splineSamples(roff, 16).map((q) => Math.hypot(...q.p));
check('offsetting a closed loop inwards keeps it closed and ~1.5 smaller', roff.closed && Math.max(...rr.map((r) => Math.abs(r - 8.5))) < 0.25, `${Math.min(...rr).toFixed(2)} … ${Math.max(...rr).toFixed(2)}`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

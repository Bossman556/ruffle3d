// Cam mate: a flat follower guided to slide in Y rides on an eccentric disc cam turned to several angles.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, solveAssembly } from '../src/kernel/build.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };

const comp = (id, features, extra = {}) => ({ id, type: 'component', p: { name: id, features, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, ...extra } });
// cam: a Ø40 × 5 disc whose centre is 5 mm off the turning axis (Z through the origin)
const cam = [{ id: 'c', type: 'cylinder', p: { r: 20, h: 5, axis: 'Z', x: 5, y: 0, z: 0, op: 'new' } }];
const guide = [{ id: 'g', type: 'box', p: { w: 10, d: 10, h: 10, x: 20, y: 50, z: 0, op: 'new' } }];
const follower = [{ id: 'f', type: 'box', p: { w: 10, d: 10, h: 10, x: 0, y: 0, z: 0, op: 'new' } }];
const mates = [
  { id: 'z', type: 'flush', a: { comp: 'K', body: 'c', p: [5, 0, 0], n: [0, 0, -1] }, b: { comp: 'F', body: 'f', p: [0, 0, 0], n: [0, 0, -1] } },
  { id: 'x', type: 'flush', offset: -20, a: { comp: 'G', body: 'g', p: [25, 50, 5], n: [1, 0, 0] }, b: { comp: 'F', body: 'f', p: [5, 0, 5], n: [1, 0, 0] } },
  { id: 'cam', type: 'cam', a: { comp: 'K', body: 'c', p: [25, 0, 2.5], n: [1, 0, 0] }, b: { comp: 'F', body: 'f', p: [0, -5, 5], n: [0, -1, 0] } },
];
let worst = 0, allOk = true, dofs = [];
for (const deg of [0, 45, 90, 180, 270]) {
  const st = (await rebuild([comp('K', cam, { grounded: true, rz: deg }), comp('G', guide, { grounded: true }), comp('F', follower, { y: 40 })])).states.at(-1);
  const s = solveAssembly(st, mates);
  allOk &&= s.assembly.mates.every((m) => m.ok);
  // the top of the disc is 20 + 5 sin θ; the follower's bottom face (local y = −5) sits on it
  const want = 20 + 5 * Math.sin((deg * Math.PI) / 180) + 5;
  worst = Math.max(worst, Math.abs(s.assembly.transforms.F.t[1] - want));
  dofs.push(s.assembly.dof);
}
check('every mate is satisfied at each cam angle', allOk);
check('the follower lift follows 20 + 5 sin θ exactly', worst < 1e-6, `worst ${worst.toExponential(2)} mm`);
check('the follower is fully located (0 degrees of freedom)', dofs.every((d) => d === 0), dofs.join());

// a roller follower: a Ø8 roller under the slider (its centre 9 below the slider's centre), riding the same cam
const roller = [...follower, { id: 'r', type: 'cylinder', p: { r: 4, h: 10, axis: 'Z', x: 0, y: -9, z: 0, op: 'join', target: 'f' } }];
const rmates = [mates[0], mates[1], { id: 'cam', type: 'cam', a: mates[2].a, b: { comp: 'F', body: 'f', p: [4, -9, 5], n: [1, 0, 0] } }];
let rworst = 0, rok = true;
for (const deg of [0, 60, 135, 250]) {
  const st = (await rebuild([comp('K', cam, { grounded: true, rz: deg }), comp('G', guide, { grounded: true }), comp('F', roller, { y: 45 })])).states.at(-1);
  const s = solveAssembly(st, rmates);
  rok &&= s.assembly.mates.every((m) => m.ok);
  // the roller centre (on x = 0) is 20 + 4 from the disc centre (5 cos θ, 5 sin θ)
  const th = (deg * Math.PI) / 180, yc = 5 * Math.sin(th) + Math.sqrt(24 * 24 - (5 * Math.cos(th)) ** 2);
  rworst = Math.max(rworst, Math.abs(s.assembly.transforms.F.t[1] - (yc + 9)));
}
check('a roller follower rides the cam exactly', rok && rworst < 1e-6, `worst ${rworst.toExponential(2)} mm`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

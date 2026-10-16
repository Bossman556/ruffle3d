// Hole wizard (ISO hole sizes) and the fastener library.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { rebuild, properties, interference } from '../src/kernel/build.js';
import { standardHole } from '../src/kernel/standards.js';

const root = path.dirname(fileURLToPath(import.meta.url));
setOC(await opencascade({ locateFile: () => path.join(root, '../node_modules/replicad-opencascadejs/dist/replicad_single.wasm') }));
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

// the tables
check('M6 clearance holes: 6.4 close, 6.6 normal, 7 loose (ISO 273)', standardHole('clearance', 'M6', 'close').diameter === 6.4 && standardHole('clearance', 'M6').diameter === 6.6 && standardHole('clearance', 'M6', 'loose').diameter === 7);
const cb = standardHole('cbore', 'M8');
check('M8 socket head counterbore: Ø9 hole, Ø15 × 8.6 counterbore', cb.diameter === 9 && cb.cbore && cb.cboreD === 15 && cb.cboreDepth === 8.6, JSON.stringify(cb));

// hole wizard in the kernel: removed volume equals the hand calculation
const plate = { id: 'pl', type: 'box', p: { w: 60, d: 40, h: 20, x: 0, y: 0, z: 0, op: 'new' } };
const V0 = 60 * 40 * 20;
const hole = (std, extra = {}) => ({ id: 'h', type: 'hole', p: { points: [{ body: 'pl', p: [0, 0, 20], n: [0, 0, 1] }], standard: std, size: 'M6', fit: 'normal', through: true, depth: 10, ...extra } });
const removed = async (h) => V0 - properties((await rebuild([plate, h])).states.at(-1).bodies.get('pl')).volume;
check('clearance hole Ø6.6 through 20 mm', near(await removed(hole('clearance')), Math.PI * 3.3 ** 2 * 20, 0.05));
check('counterbore adds Ø11 × 6.4', near(await removed(hole('cbore')), Math.PI * 3.3 ** 2 * 20 + Math.PI * (5.5 ** 2 - 3.3 ** 2) * 6.4, 0.05));
const old = await removed({ id: 'h', type: 'hole', p: { points: [{ body: 'pl', p: [0, 0, 20], n: [0, 0, 1] }], diameter: 5, through: true, depth: 10 } });
check('holes without a type keep their custom sizes', near(old, Math.PI * 2.5 ** 2 * 20, 0.05));

// fasteners: an M6 × 20 cap screw in the counterbored hole, a nut under the plate and a washer on top
const cboreHole = hole('cbore');
const screw = { id: 'sc', type: 'fastener', p: { face: [{ body: 'pl', p: [3.3, 0, 12], n: [-1, 0, 0] }], kind: 'shcs', size: 'M6', length: 20 } };
const nut = { id: 'nt', type: 'fastener', p: { face: [{ body: 'pl', p: [3.3, 0, 1], n: [-1, 0, 0] }], kind: 'nut', size: 'M6' } };
const washer = { id: 'wa', type: 'fastener', p: { face: [{ body: 'pl', p: [20, 10, 20], n: [0, 0, 1] }], kind: 'washer', size: 'M6' } };
const r = await rebuild([plate, cboreHole, screw, nut, washer]);
const st = r.states.at(-1), bb = (id) => properties(st.bodies.get(id)).bbox;
check('fasteners build', !r.errors.sc && !r.errors.nt && !r.errors.wa, `${r.errors.sc || ''} ${r.errors.nt || ''} ${r.errors.wa || ''}`);
const s = bb('sc');
check('the screw head sits in the counterbore (top 0.4 below the surface) and the shank goes down 20 mm', near(s[1][2], 20 - 6.4 + 6) && near(s[0][2], 20 - 6.4 - 20) && near(s[1][0] - s[0][0], 10), JSON.stringify(s));
const n = bb('nt');
check('the nut sits under the plate on the hole axis', near(n[1][2], 0) && near(n[0][2], -5.2) && near((n[0][0] + n[1][0]) / 2, 0), JSON.stringify(n));
const w = bb('wa');
check('the washer lies on the top face where it was clicked', near(w[0][2], 20) && near(w[1][2], 21.6) && near((w[0][0] + w[1][0]) / 2, 20) && near(w[1][0] - w[0][0], 12), JSON.stringify(w));
const clash = interference([['pl', st.bodies.get('pl')], ['sc', st.bodies.get('sc')], ['nt', st.bodies.get('nt')]]);
check('nothing overlaps: the screw clears the hole and the counterbore', clash.length === 0, JSON.stringify(clash.map((c) => [c.a, c.b, c.volume.toFixed(3)])));
const hb = await rebuild([plate, hole('clearance'), { id: 'hb', type: 'fastener', p: { face: [{ body: 'pl', p: [3.3, 0, 19], n: [-1, 0, 0] }], kind: 'hexbolt', size: 'M6', length: 30 } }, { id: 'ck', type: 'fastener', p: { face: [{ body: 'pl', p: [20, 10, 20], n: [0, 0, 1] }], kind: 'csk', size: 'M6', length: 16 } }]);
const hbb = properties(hb.states.at(-1).bodies.get('hb')).bbox, ckb = properties(hb.states.at(-1).bodies.get('ck')).bbox;
check('a hex bolt head stands on the surface (4 mm high, 10 mm across flats)', !hb.errors.hb && near(hbb[0][2], -10) && near(hbb[1][2], 24) && near(hbb[1][1] - hbb[0][1], 10, 1e-2), JSON.stringify(hbb));
check('a countersunk screw is flush with the face and 16 mm long overall', !hb.errors.ck && near(ckb[1][2], 20) && near(ckb[0][2], 4), JSON.stringify(ckb));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

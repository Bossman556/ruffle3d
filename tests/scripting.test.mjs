// Scripting: the sketch builder and the r3d API, against a minimal stand-in for the app.
import { sketchBuilder, runScript } from '../src/scripting.js';

let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };

// sketch builder
const r = sketchBuilder().centerRect(0, 0, 40, 20).data();
check('a rectangle is 4 lines on 4 shared corners', r.curves.length === 4 && r.points.length === 4 && r.curves.every((c) => c.type === 'line'));
const s = sketchBuilder().slot(0, 0, 50, 0, 20).data();
const P = (id) => s.points.find((q) => q.id === id);
const arcs = s.curves.filter((c) => c.type === 'arc'), lines = s.curves.filter((c) => c.type === 'line');
check('a slot is two lines and two arcs joined end to end', arcs.length === 2 && lines.length === 2 && s.points.length === 6, `${s.points.length} points`);
check('the slot is 20 wide', lines.every((l) => Math.abs(Math.abs(P(l.a).y) - 10) < 1e-9 && Math.abs(Math.abs(P(l.b).y) - 10) < 1e-9));
const poly = sketchBuilder().polygon(0, 0, 10, 6).data();
check('a hexagon closes on itself', poly.curves.length === 6 && poly.points.length === 6);

// the API against a stand-in app
const app = {
  doc: { features: [], marker: 0, params: [], configs: [], units: 'mm' },
  result: { bodies: [], errors: {} },
  ctx: () => ({}),
  bodyMeta: () => ({ name: 'Body', material: 'steel' }),
  rebuild: async () => {},
};
const out = [];
const log = (t, kind) => out.push([t, kind]);
let res = await runScript(app, `
r3d.param('w', 60);
r3d.param('h', 'w / 2');
const sk = r3d.sketch('XY', (s) => s.circle(0, 0, 'ignored' ? 5 : 1));
const ex = r3d.extrude(sk, 'h', { side: 'symmetric' });
r3d.log('made', ex, r3d.param('h'));
`, log);
const f = app.doc.features;
check('a script runs and adds features in order', res.ok && f.length === 2 && f[0].type === 'sketch' && f[1].type === 'extrude' && app.doc.marker === 2, JSON.stringify(res));
check('parameters are created and read back', app.doc.params.map((p) => `${p.name}=${p.expr}`).join() === 'w=60,h=w / 2');
check('extrude refers to its sketch, uses all regions and keeps options', f[1].p.sketch === f[0].id && f[1].p.profiles.length === 0 && f[1].p.distance === 'h' && f[1].p.side === 'symmetric');
check('a sketch on XY stores the standard plane', f[0].p.planeRef?.name === 'XY' && f[0].p.plane?.normal?.[2] === 1);
check('r3d.log writes to the output', out.some(([t]) => t.startsWith('made ') && t.endsWith(' w / 2')), JSON.stringify(out));
out.length = 0;
res = await runScript(app, `r3d.log('one');\nr3d.feature('nonsense', {});`, log);
check('an unknown feature type stops the script with its line number', !res.ok && res.line === 2 && /Unknown feature type "nonsense"/.test(res.error), JSON.stringify(res));
res = await runScript(app, `r3d.log(;`, log);
check('a syntax error is reported without running anything', !res.ok && /Syntax error/.test(out.at(-1)[0]));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

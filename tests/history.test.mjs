// Undo history: plain-language descriptions of changes between snapshots.
import { describeChange } from '../src/history.js';

let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failures++; };

const base = {
  name: 'Bracket', units: 'mm', marker: 2,
  params: [{ name: 'width', expr: '60' }],
  features: [{ id: 's', type: 'sketch', name: 'Sketch 1', p: { points: [] } }, { id: 'e', type: 'extrude', name: 'Extrude 1', p: { distance: '10' } }],
  bodies: { e: { name: 'Body1', material: 'aluminum', visible: true } },
};
const edit = (fn) => { const d = structuredClone(base); fn(d); return d; };

let msg = describeChange(base, edit((d) => { d.features.push({ id: 'f', type: 'fillet', name: 'Fillet 1', p: {} }); d.marker = 3; }));
check('adding a feature', msg === 'Added Fillet 1', msg);
msg = describeChange(base, edit((d) => { d.features.splice(1, 1); d.marker = 1; }));
check('deleting a feature', msg === 'Deleted Extrude 1', msg);
msg = describeChange(base, edit((d) => { d.features[1].p.distance = '20'; }));
check('editing a feature', msg === 'Edited Extrude 1', msg);
msg = describeChange(base, edit((d) => { d.features[0].p.points = [{ id: 'p', x: 1, y: 2 }]; }));
check('editing a sketch', msg === 'Edited sketch Sketch 1', msg);
msg = describeChange(base, edit((d) => { d.params[0].expr = '80'; }));
check('changing a parameter says what to', msg === 'Changed parameter width to 80', msg);
msg = describeChange(base, edit((d) => { d.bodies.e.visible = false; }));
check('hiding a body', msg === 'Hid Body1', msg);
msg = describeChange(base, edit((d) => { d.bodies.e.material = 'steel'; }));
check('changing a material', msg === 'Changed the material of Body1', msg);
msg = describeChange(base, edit((d) => { d.marker = 1; }));
check('rolling the timeline back', msg === 'Rolled the timeline back', msg);
msg = describeChange(base, edit((d) => { d.features[1].suppressed = true; }));
check('suppressing', msg === 'Suppressed Extrude 1', msg);
msg = describeChange(base, edit((d) => { d.features[1].name = 'Base'; }));
check('renaming', msg === 'Renamed Extrude 1 to Base', msg);
msg = describeChange(base, edit((d) => { d.features.reverse(); }));
check('reordering', msg === 'Reordered the timeline', msg);
msg = describeChange(base, edit((d) => { d.dwgAnno = [{ id: 'a' }]; d.params[0].expr = '1'; d.features[1].p.distance = '5'; }));
check('several changes are summarised', msg.startsWith('Edited Extrude 1; Changed parameter width to 1') && msg.endsWith('; …'), msg);
check('identical snapshots', describeChange(base, structuredClone(base)) === 'No change');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);

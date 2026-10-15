// Plain-language descriptions of what changed between two snapshots of a design, for the undo
// history list ("Added Fillet 2", "Changed parameter width"). Snapshots are whole documents.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const list = (names, max = 2) => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`);

export function describeChange(a, b) {
  if (!a || !b) return 'Changed the design';
  const out = [];
  const fa = a.features || [], fb = b.features || [];
  const byIdA = new Map(fa.map((f) => [f.id, f])), byIdB = new Map(fb.map((f) => [f.id, f]));
  const added = fb.filter((f) => !byIdA.has(f.id)), removed = fa.filter((f) => !byIdB.has(f.id));
  if (added.length) out.push(`Added ${list(added.map((f) => f.name || f.type))}`);
  if (removed.length) out.push(`Deleted ${list(removed.map((f) => f.name || f.type))}`);
  const both = fb.filter((f) => byIdA.has(f.id));
  const renamed = both.filter((f) => (byIdA.get(f.id).name || '') !== (f.name || ''));
  if (renamed.length) out.push(`Renamed ${list(renamed.map((f) => `${byIdA.get(f.id).name} to ${f.name}`), 1)}`);
  const supp = both.filter((f) => !!byIdA.get(f.id).suppressed !== !!f.suppressed);
  if (supp.length) out.push(`${supp.every((f) => f.suppressed) ? 'Suppressed' : supp.every((f) => !f.suppressed) ? 'Unsuppressed' : 'Toggled'} ${list(supp.map((f) => f.name))}`);
  const edited = both.filter((f) => !same(byIdA.get(f.id).p, f.p));
  if (edited.length) out.push(`${edited.every((f) => f.type === 'sketch') ? 'Edited sketch' : 'Edited'} ${list(edited.map((f) => f.name || f.type))}`);
  const orderA = fa.filter((f) => byIdB.has(f.id)).map((f) => f.id), orderB = both.map((f) => f.id);
  if (!added.length && !removed.length && !same(orderA, orderB)) out.push('Reordered the timeline');
  if ((a.marker ?? fa.length) !== (b.marker ?? fb.length) && !added.length && !removed.length) out.push((b.marker ?? fb.length) < (a.marker ?? fa.length) ? 'Rolled the timeline back' : 'Rolled the timeline forward');
  const pa = new Map((a.params || []).map((p) => [p.name, p])), pb = new Map((b.params || []).map((p) => [p.name, p]));
  const pAdded = [...pb.keys()].filter((k) => !pa.has(k)), pRemoved = [...pa.keys()].filter((k) => !pb.has(k)), pChanged = [...pb.keys()].filter((k) => pa.has(k) && pa.get(k).expr !== pb.get(k).expr);
  if (pAdded.length) out.push(`Added parameter ${list(pAdded)}`);
  if (pRemoved.length) out.push(`Deleted parameter ${list(pRemoved)}`);
  if (pChanged.length) out.push(`Changed ${pChanged.length === 1 ? `parameter ${pChanged[0]} to ${pb.get(pChanged[0]).expr}` : `parameters ${list(pChanged)}`}`);
  if (!same(a.configs || [], b.configs || []) || a.activeConfig !== b.activeConfig) out.push(a.activeConfig !== b.activeConfig ? 'Switched configuration' : 'Changed configurations');
  // bodies: material, appearance, visibility, name
  const ba = a.bodies || {}, bb = b.bodies || {};
  const bChanged = Object.keys(bb).filter((k) => ba[k] && !same(ba[k], bb[k]));
  if (bChanged.length) {
    const kinds = new Set(bChanged.map((k) => (ba[k].visible !== bb[k].visible ? (bb[k].visible === false ? 'hid' : 'showed') : ba[k].material !== bb[k].material ? 'material' : ba[k].name !== bb[k].name ? 'renamed' : 'appearance')));
    const names = bChanged.map((k) => bb[k].name || k);
    const verb = kinds.size > 1 ? 'Changed' : { hid: 'Hid', showed: 'Showed', material: 'Changed the material of', renamed: 'Renamed body', appearance: 'Changed the appearance of' }[[...kinds][0]];
    out.push(`${verb} ${list(names)}`);
  }
  if (!same(a.mates || [], b.mates || [])) out.push(`${(b.mates || []).length > (a.mates || []).length ? 'Added a mate' : (b.mates || []).length < (a.mates || []).length ? 'Deleted a mate' : 'Edited mates'}`);
  if (!same(a.dwgAnno || [], b.dwgAnno || [])) out.push('Changed drawing annotations');
  if (!same(a.cam, b.cam)) out.push('Changed machining setup');
  if (!same(a.sim, b.sim)) out.push('Changed simulation setup');
  if (a.units !== b.units) out.push(`Switched units to ${b.units}`);
  if (a.name !== b.name) out.push(`Renamed the design to ${b.name}`);
  if (!out.length) return same(a, b) ? 'No change' : 'Changed the design';
  return out.slice(0, 2).join('; ') + (out.length > 2 ? '; …' : '');
}

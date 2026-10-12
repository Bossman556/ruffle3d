// A small parametric mounting bracket used as the starting design.
// The plate is a fully constrained sketch driven by parameters: MODIFY ▸ Change Parameters,
// set plate_w = 120 and watch the sketch and everything downstream rebuild.
export function demoDocument() {
  return {
    version: 1,
    name: 'Mounting Bracket',
    params: [
      { name: 'plate_w', expr: '80', comment: 'Plate length' },
      { name: 'plate_d', expr: '50', comment: 'Plate width' },
      { name: 'thick', expr: '8', comment: 'Plate thickness' },
      { name: 'boss_r', expr: '12', comment: 'Boss radius' },
      { name: 'bolt', expr: '6.5', comment: 'Bolt hole diameter' },
    ],
    features: [
      { id: 'skA', type: 'sketch', name: 'Plate Sketch', hidden: true, p: {
        planeRef: { type: 'std', name: 'XY' }, plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
        points: [{ id: 'q0', x: -40, y: -25 }, { id: 'q1', x: 40, y: -25 }, { id: 'q2', x: 40, y: 25 }, { id: 'q3', x: -40, y: 25 }],
        curves: [
          { id: 'l0', type: 'line', a: 'q0', b: 'q1' }, { id: 'l1', type: 'line', a: 'q1', b: 'q2' },
          { id: 'l2', type: 'line', a: 'q2', b: 'q3' }, { id: 'l3', type: 'line', a: 'q3', b: 'q0' },
          { id: 'l4', type: 'line', a: 'q0', b: 'q2', construction: true },
        ],
        constraints: [
          { id: 'k0', type: 'horizontal', line: 'l0' }, { id: 'k1', type: 'horizontal', line: 'l2' },
          { id: 'k2', type: 'vertical', line: 'l1' }, { id: 'k3', type: 'vertical', line: 'l3' },
          { id: 'k4', type: 'midpoint', p: 'O', line: 'l4' },
        ],
        dims: [
          { id: 'd0', type: 'length', line: 'l0', expr: 'plate_w', off: [0, -9] },
          { id: 'd1', type: 'length', line: 'l1', expr: 'plate_d', off: [9, 0] },
        ],
      } },
      { id: 'exA', type: 'extrude', name: 'Plate', p: { sketch: 'skA', profiles: [], side: 'one', distance: 'thick', distance2: '10', twist: '0', op: 'new', target: '' } },
      { id: 'cyA', type: 'cylinder', name: 'Boss', p: { r: 'boss_r', h: 'thick * 3', axis: 'Z', x: '0', y: '0', z: '0', op: 'join', target: 'exA' } },
      { id: 'fiA', type: 'fillet', name: 'Corner Fillets', p: { radius: '6', edges: [
        { body: 'exA', p: [40, 25, 4], u: [1, 1, 1 / 6] }, { body: 'exA', p: [-40, 25, 4], u: [0, 1, 1 / 6] },
        { body: 'exA', p: [40, -25, 4], u: [1, 0, 1 / 6] }, { body: 'exA', p: [-40, -25, 4], u: [0, 0, 1 / 6] },
      ] } },
      { id: 'hoA', type: 'hole', name: 'Boss Bore', p: { points: [{ body: 'exA', p: [0, 0, 24], n: [0, 0, 1], u: [0.5, 0.5, 1] }], diameter: '10', through: true, depth: '10', cbore: false, cboreD: '10', cboreDepth: '3' } },
      { id: 'hoB', type: 'hole', name: 'Bolt Holes', p: { points: [
        { body: 'exA', p: [30, 15, 8], n: [0, 0, 1], u: [0.875, 0.8, 1 / 3] }, { body: 'exA', p: [-30, 15, 8], n: [0, 0, 1], u: [0.125, 0.8, 1 / 3] },
        { body: 'exA', p: [30, -15, 8], n: [0, 0, 1], u: [0.875, 0.2, 1 / 3] }, { body: 'exA', p: [-30, -15, 8], n: [0, 0, 1], u: [0.125, 0.2, 1 / 3] },
      ], diameter: 'bolt', through: true, depth: '10', cbore: true, cboreD: 'bolt * 1.7', cboreDepth: '3' } },
      { id: 'chA', type: 'chamfer', name: 'Boss Chamfer', p: { distance: '1.5', edges: [{ body: 'exA', p: [0, 12, 24], u: [0.5, 0.74, 1] }] } },
    ],
    marker: 7,
    bodies: { exA: { name: 'Bracket', material: 'aluminum', visible: true } },
    counters: { body: 1, sketch: 1 },
    originVisible: false,
  };
}

// Electronics enclosure: box, rounded vertical edges, shelled from the top, with mounting holes.
export function enclosureDocument() {
  return {
    version: 1,
    name: 'Electronics Enclosure',
    units: 'mm',
    params: [
      { name: 'L', expr: '90', comment: 'Length' },
      { name: 'W', expr: '60', comment: 'Width' },
      { name: 'H', expr: '32', comment: 'Height' },
      { name: 'wall', expr: '2', comment: 'Wall thickness' },
      { name: 'r', expr: '6', comment: 'Corner radius' },
    ],
    features: [
      { id: 'enB', type: 'box', name: 'Shell Blank', p: { w: 'L', d: 'W', h: 'H', x: '0', y: '0', z: '0', op: 'new', target: '' } },
      { id: 'enF', type: 'fillet', name: 'Corner Rounds', p: { radius: 'r', edges: [
        { body: 'enB', p: [45, 30, 16], u: [1, 1, 0.5] }, { body: 'enB', p: [-45, 30, 16], u: [0, 1, 0.5] },
        { body: 'enB', p: [45, -30, 16], u: [1, 0, 0.5] }, { body: 'enB', p: [-45, -30, 16], u: [0, 0, 0.5] },
      ] } },
      { id: 'enF2', type: 'fillet', name: 'Bottom Round', p: { radius: '3', edges: [{ body: 'enB', p: [0, -30, 0], u: [0.5, 0, 0] }] } },
      { id: 'enS', type: 'shell', name: 'Shell', p: { faces: [{ body: 'enB', p: [0, 0, 32], n: [0, 0, 1], u: [0.5, 0.5, 1] }], thickness: 'wall', dir: 'inside' } },
      { id: 'enH', type: 'hole', name: 'Cable Port', p: { points: [{ body: 'enB', p: [-45, 0, 14], n: [-1, 0, 0], u: [0, 0.5, 0.4375] }], diameter: '8', through: false, depth: '6', cbore: false, cboreD: '10', cboreDepth: '3', csink: false, csinkD: '12' } },
    ],
    marker: 5,
    bodies: { enB: { name: 'Enclosure', material: 'abs', visible: true } },
    counters: { body: 1, sketch: 0 },
    originVisible: false,
  };
}

// Surface study: a computer-mouse shell skinned through three spline sections, then thickened.
export function surfaceDocument() {
  const sec = (id, name, y, w, h) => {
    const pts = [[-w, 0], [-w * 0.82, h * 0.72], [0, h], [w * 0.82, h * 0.72], [w, 0]].map(([x, z], i) => ({ id: `${id}p${i}`, x, y: z }));
    return { id, type: 'sketch', name, p: {
      planeRef: null, plane: { origin: [0, y, 0], xDir: [1, 0, 0], normal: [0, -1, 0] },
      points: pts, curves: [{ id: `${id}c`, type: 'spline', pts: pts.map((p) => p.id), closed: false }], constraints: [], dims: [],
    } };
  };
  return {
    version: 1,
    name: 'Mouse Shell',
    units: 'mm',
    params: [{ name: 'wall', expr: '1.6', comment: 'Shell wall thickness' }],
    features: [
      sec('msA', 'Section Rear', -38, 17, 13),
      sec('msB', 'Section Mid', -6, 31, 31),
      sec('msC', 'Section Front', 32, 26, 21),
      { id: 'msS', type: 'surfloft', name: 'Body Skin', p: { sections: ['msA', 'msB', 'msC'], ruled: false } },
      { id: 'msT', type: 'thicken', name: 'Wall', p: { body: 'msS', thickness: 'wall', side: 'out' } },
    ],
    marker: 5,
    bodies: { msS: { name: 'Mouse Shell', material: 'abs', visible: true, look: { name: 'Gloss Black', color: '#16171a', finish: 'gloss', metalness: 0, roughness: 0.22, opacity: 1, clearcoat: 0.6, clearcoatRoughness: 0.1, sheen: 0 } } },
    counters: { body: 1, sketch: 3 },
    originVisible: false,
  };
}

export function blankDocument(units = 'mm') {
  return { version: 1, name: 'Untitled', units, params: [], features: [], marker: 0, bodies: {}, counters: { body: 0, sketch: 0 }, originVisible: false };
}

export const TEMPLATES = [
  { id: 'blank-mm', name: 'Blank part', sub: 'Millimetres', make: () => blankDocument('mm') },
  { id: 'blank-in', name: 'Blank part', sub: 'Inches', make: () => blankDocument('in') },
  { id: 'bracket', name: 'Mounting bracket', sub: 'Parametric sketch · holes · fillets', make: demoDocument },
  { id: 'enclosure', name: 'Electronics enclosure', sub: 'Shell · rounds · ports', make: enclosureDocument },
  { id: 'surface', name: 'Mouse shell', sub: 'Surfaces · skin · thicken', make: surfaceDocument },
];

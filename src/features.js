// Feature catalog: every timeline feature type, its dialog fields and defaults.
// Field types: number (expression), int, select, check, body, bodies, edges, faces, points, sketch, curves (ordered sketch list).

const OP = { key: 'op', label: 'Operation', type: 'select', options: [['new', 'New Body'], ['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']], default: 'new' };
const TARGET = { key: 'target', label: 'Target body', type: 'body', show: (p) => p.op !== 'new' };
const POS = [
  { key: 'x', label: 'X', type: 'number', default: '0', unit: 'mm' },
  { key: 'y', label: 'Y', type: 'number', default: '0', unit: 'mm' },
  { key: 'z', label: 'Z', type: 'number', default: '0', unit: 'mm' },
];
const AXIS3 = [['X', 'X axis'], ['Y', 'Y axis'], ['Z', 'Z axis']];

export const FEATURES = {
  sketch: { label: 'Sketch', icon: 'sketch', group: 'create', fields: [] },
  extrude: {
    label: 'Extrude', icon: 'extrude', group: 'create', key: 'E',
    fields: [
      { key: 'sketch', label: 'Sketch', type: 'sketch' },
      { key: 'profiles', label: 'Profiles', type: 'regions', of: 'sketch' },
      { key: 'side', label: 'Direction', type: 'select', options: [['one', 'One side'], ['symmetric', 'Symmetric'], ['two', 'Two sides']], default: 'one' },
      { key: 'distance', label: 'Distance', type: 'number', default: '20', unit: 'mm' },
      { key: 'distance2', label: 'Distance 2', type: 'number', default: '10', unit: 'mm', show: (p) => p.side === 'two' },
      { key: 'twist', label: 'Twist angle', type: 'number', default: '0', unit: '°', show: (p) => p.side === 'one' },
      OP, TARGET,
    ],
  },
  revolve: {
    label: 'Revolve', icon: 'revolve', group: 'create',
    fields: [
      { key: 'sketch', label: 'Sketch', type: 'sketch' },
      { key: 'profiles', label: 'Profiles', type: 'regions', of: 'sketch' },
      { key: 'axis', label: 'Axis', type: 'select', options: [['sy', 'Sketch vertical axis'], ['sx', 'Sketch horizontal axis'], ['X', 'World X'], ['Y', 'World Y'], ['Z', 'World Z']], default: 'sy' },
      { key: 'angle', label: 'Angle', type: 'number', default: '360', unit: '°' },
      OP, TARGET,
    ],
  },
  loft: {
    label: 'Loft', icon: 'loft', group: 'create',
    fields: [
      { key: 'sketch', label: 'Sketch 1', type: 'sketch' },
      { key: 'profiles', label: 'Profile 1', type: 'regions', of: 'sketch' },
      { key: 'sketch2', label: 'Sketch 2', type: 'sketch' },
      { key: 'ruled', label: 'Ruled (straight)', type: 'check', default: false },
      OP, TARGET,
    ],
  },
  box: {
    label: 'Box', icon: 'box', group: 'create',
    fields: [
      { key: 'w', label: 'Length (X)', type: 'number', default: '50', unit: 'mm' },
      { key: 'd', label: 'Width (Y)', type: 'number', default: '30', unit: 'mm' },
      { key: 'h', label: 'Height (Z)', type: 'number', default: '20', unit: 'mm' },
      ...POS, OP, TARGET,
    ],
  },
  cylinder: {
    label: 'Cylinder', icon: 'cylinder', group: 'create',
    fields: [
      { key: 'r', label: 'Radius', type: 'number', default: '15', unit: 'mm' },
      { key: 'h', label: 'Height', type: 'number', default: '30', unit: 'mm' },
      { key: 'axis', label: 'Axis', type: 'select', options: AXIS3, default: 'Z' },
      ...POS, OP, TARGET,
    ],
  },
  sphere: {
    label: 'Sphere', icon: 'sphere', group: 'create',
    fields: [{ key: 'r', label: 'Radius', type: 'number', default: '20', unit: 'mm' }, ...POS, OP, TARGET],
  },
  torus: {
    label: 'Torus', icon: 'torus', group: 'create',
    fields: [
      { key: 'R', label: 'Major radius', type: 'number', default: '25', unit: 'mm' },
      { key: 'r', label: 'Minor radius', type: 'number', default: '6', unit: 'mm' },
      ...POS, OP, TARGET,
    ],
  },
  cone: {
    label: 'Cone', icon: 'cone', group: 'create',
    fields: [
      { key: 'r1', label: 'Base radius', type: 'number', default: '20', unit: 'mm' },
      { key: 'r2', label: 'Top radius', type: 'number', default: '0', unit: 'mm' },
      { key: 'h', label: 'Height', type: 'number', default: '35', unit: 'mm' },
      ...POS, OP, TARGET,
    ],
  },
  hole: {
    label: 'Hole', icon: 'hole', group: 'create', key: 'H',
    fields: [
      { key: 'points', label: 'Position', type: 'points', hint: 'Click points on faces' },
      { key: 'standard', label: 'Type', type: 'select', options: [['custom', 'Custom sizes'], ['clearance', 'Clearance hole (ISO 273)'], ['cbore', 'Counterbore for socket head screw (ISO 4762)'], ['csink', 'Countersink for flat head screw (ISO 10642)'], ['tapped', 'Tapped (threaded) hole']], default: 'custom' },
      { key: 'size', label: 'Screw size', type: 'select', options: [['M2', 'M2'], ['M2.5', 'M2.5'], ['M3', 'M3'], ['M4', 'M4'], ['M5', 'M5'], ['M6', 'M6'], ['M8', 'M8'], ['M10', 'M10'], ['M12', 'M12'], ['M14', 'M14'], ['M16', 'M16'], ['M20', 'M20'], ['M24', 'M24']], default: 'M6', show: (p) => p.standard && p.standard !== 'custom' },
      { key: 'fit', label: 'Fit', type: 'select', options: [['close', 'Close (fine)'], ['normal', 'Normal (medium)'], ['loose', 'Loose (coarse)']], default: 'normal', show: (p) => ['clearance', 'cbore', 'csink'].includes(p.standard) },
      { key: 'tapped', label: 'Tapped (threaded)', type: 'check', default: false, show: (p) => !p.standard || p.standard === 'custom' },
      { key: 'tapSize', label: 'Thread', type: 'select', options: [['M2', 'M2 × 0.4'], ['M2.5', 'M2.5 × 0.45'], ['M3', 'M3 × 0.5'], ['M4', 'M4 × 0.7'], ['M5', 'M5 × 0.8'], ['M6', 'M6 × 1'], ['M8', 'M8 × 1.25'], ['M10', 'M10 × 1.5'], ['M12', 'M12 × 1.75'], ['M14', 'M14 × 2'], ['M16', 'M16 × 2'], ['M20', 'M20 × 2.5'], ['M24', 'M24 × 3']], default: 'M6', show: (p) => (!p.standard || p.standard === 'custom') && p.tapped },
      { key: 'diameter', label: 'Diameter', type: 'number', default: '6', unit: 'mm', show: (p) => (!p.standard || p.standard === 'custom') && !p.tapped },
      { key: 'through', label: 'Through all', type: 'check', default: false },
      { key: 'depth', label: 'Depth', type: 'number', default: '10', unit: 'mm', show: (p) => !p.through },
      { key: 'threadDepth', label: 'Thread depth', type: 'number', default: '8', unit: 'mm', show: (p) => (p.standard === 'tapped' || ((!p.standard || p.standard === 'custom') && p.tapped)) && !p.through },
      { key: 'cbore', label: 'Counterbore', type: 'check', default: false, show: (p) => !p.standard || p.standard === 'custom' },
      { key: 'cboreD', label: 'Cbore diameter', type: 'number', default: '10', unit: 'mm', show: (p) => (!p.standard || p.standard === 'custom') && p.cbore },
      { key: 'cboreDepth', label: 'Cbore depth', type: 'number', default: '3', unit: 'mm', show: (p) => (!p.standard || p.standard === 'custom') && p.cbore },
      { key: 'csink', label: 'Countersink', type: 'check', default: false, show: (p) => (!p.standard || p.standard === 'custom') && !p.cbore },
      { key: 'csinkD', label: 'Csink diameter', type: 'number', default: '12', unit: 'mm', show: (p) => (!p.standard || p.standard === 'custom') && p.csink && !p.cbore },
    ],
  },
  rpattern: {
    label: 'Rectangular Pattern', icon: 'rpattern', group: 'create',
    fields: [
      { key: 'bodies', label: 'Bodies', type: 'bodies' },
      { key: 'dir1', label: 'Direction 1', type: 'select', options: AXIS3, default: 'X' },
      { key: 'count1', label: 'Quantity 1', type: 'int', default: '3' },
      { key: 'spacing1', label: 'Spacing 1', type: 'number', default: '30', unit: 'mm' },
      { key: 'dir2', label: 'Direction 2', type: 'select', options: [['none', 'None'], ...AXIS3], default: 'none' },
      { key: 'count2', label: 'Quantity 2', type: 'int', default: '2', show: (p) => p.dir2 !== 'none' },
      { key: 'spacing2', label: 'Spacing 2', type: 'number', default: '30', unit: 'mm', show: (p) => p.dir2 !== 'none' },
      { key: 'join', label: 'Join into one body', type: 'check', default: true },
    ],
  },
  ppattern: {
    label: 'Path Pattern', icon: 'ppattern', group: 'create',
    fields: [
      { key: 'bodies', label: 'Bodies', type: 'bodies' },
      { key: 'path', label: 'Path sketch', type: 'sketch', curve: true },
      { key: 'count', label: 'Quantity', type: 'int', default: '6' },
      { key: 'mode', label: 'Spacing', type: 'select', options: [['fit', 'Spread along the whole path'], ['spacing', 'Set distance apart']], default: 'fit' },
      { key: 'spacing', label: 'Distance', type: 'number', default: '20', unit: 'mm', show: (p) => p.mode === 'spacing' },
      { key: 'orient', label: 'Orientation', type: 'select', options: [['fixed', 'Keep orientation'], ['follow', 'Turn with the path']], default: 'fixed' },
      { key: 'join', label: 'Join into one body', type: 'check', default: true },
    ],
  },
  cpattern: {
    label: 'Circular Pattern', icon: 'cpattern', group: 'create',
    fields: [
      { key: 'bodies', label: 'Bodies', type: 'bodies' },
      { key: 'axis', label: 'Axis', type: 'select', options: AXIS3, default: 'Z' },
      { key: 'cx', label: 'Center X', type: 'number', default: '0', unit: 'mm' },
      { key: 'cy', label: 'Center Y', type: 'number', default: '0', unit: 'mm' },
      { key: 'cz', label: 'Center Z', type: 'number', default: '0', unit: 'mm' },
      { key: 'count', label: 'Quantity', type: 'int', default: '6' },
      { key: 'angle', label: 'Total angle', type: 'number', default: '360', unit: '°' },
      { key: 'join', label: 'Join into one body', type: 'check', default: true },
    ],
  },
  mirror: {
    label: 'Mirror', icon: 'mirror', group: 'create',
    fields: [
      { key: 'bodies', label: 'Bodies', type: 'bodies' },
      { key: 'plane', label: 'Mirror plane', type: 'planeRef', default: { type: 'std', name: 'YZ' } },
      { key: 'offset', label: 'Plane offset', type: 'number', default: '0', unit: 'mm' },
      { key: 'join', label: 'Join with original', type: 'check', default: false },
    ],
  },
  fillet: {
    label: 'Fillet', icon: 'fillet', group: 'modify', key: 'F',
    fields: [
      { key: 'edges', label: 'Edges', type: 'edges', hint: 'Click edges' },
      { key: 'radius', label: 'Radius', type: 'number', default: '3', unit: 'mm' },
    ],
  },
  chamfer: {
    label: 'Chamfer', icon: 'chamfer', group: 'modify',
    fields: [
      { key: 'edges', label: 'Edges', type: 'edges', hint: 'Click edges' },
      { key: 'distance', label: 'Distance', type: 'number', default: '2', unit: 'mm' },
    ],
  },
  shell: {
    label: 'Shell', icon: 'shell', group: 'modify',
    fields: [
      { key: 'faces', label: 'Faces to remove', type: 'faces', hint: 'Click faces to open' },
      { key: 'thickness', label: 'Thickness', type: 'number', default: '2', unit: 'mm' },
      { key: 'dir', label: 'Direction', type: 'select', options: [['inside', 'Inside'], ['outside', 'Outside']], default: 'inside' },
    ],
  },
  combine: {
    label: 'Combine', icon: 'combine', group: 'modify',
    fields: [
      { key: 'target', label: 'Target body', type: 'body' },
      { key: 'tools', label: 'Tool bodies', type: 'bodies' },
      { key: 'op', label: 'Operation', type: 'select', options: [['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']], default: 'join' },
      { key: 'keep', label: 'Keep tools', type: 'check', default: false },
    ],
  },
  move: {
    label: 'Move / Copy', icon: 'move', group: 'modify', key: 'M',
    fields: [
      { key: 'bodies', label: 'Bodies', type: 'bodies' },
      { key: 'dx', label: 'X distance', type: 'number', default: '0', unit: 'mm' },
      { key: 'dy', label: 'Y distance', type: 'number', default: '0', unit: 'mm' },
      { key: 'dz', label: 'Z distance', type: 'number', default: '0', unit: 'mm' },
      { key: 'rx', label: 'X angle', type: 'number', default: '0', unit: '°' },
      { key: 'ry', label: 'Y angle', type: 'number', default: '0', unit: '°' },
      { key: 'rz', label: 'Z angle', type: 'number', default: '0', unit: '°' },
      { key: 'pivot', label: 'Rotate about', type: 'select', options: [['center', 'Body center'], ['origin', 'World origin']], default: 'center' },
      { key: 'copy', label: 'Create copy', type: 'check', default: false },
    ],
  },
  scale: {
    label: 'Scale', icon: 'scale', group: 'modify',
    fields: [
      { key: 'bodies', label: 'Bodies', type: 'bodies' },
      { key: 'factor', label: 'Scale factor', type: 'number', default: '2' },
      { key: 'pivot', label: 'Point', type: 'select', options: [['center', 'Body center'], ['origin', 'World origin']], default: 'center' },
    ],
  },
  sweep: {
    label: 'Sweep', icon: 'sweep', group: 'create',
    fields: [
      { key: 'sketch', label: 'Profile sketch', type: 'sketch' },
      { key: 'profiles', label: 'Profiles', type: 'regions', of: 'sketch' },
      { key: 'path', label: 'Path sketch', type: 'sketch' },
      { key: 'orient', label: 'Orientation', type: 'select', options: [['frenet', 'Follow path'], ['fixed', 'Fixed']], default: 'frenet' },
      OP, TARGET,
    ],
  },
  plane: {
    label: 'Construction Plane', icon: 'plane2', group: 'construct',
    fields: [
      { key: 'mode', label: 'Type', type: 'select', options: [['offset', 'Offset plane'], ['angle', 'Plane at angle'], ['mid', 'Midplane']], default: 'offset' },
      { key: 'base', label: 'Reference', type: 'planeRef', default: { type: 'std', name: 'XY' } },
      { key: 'base2', label: 'Second plane', type: 'planeRef', default: { type: 'std', name: 'XY' }, show: (p) => p.mode === 'mid' },
      { key: 'distance', label: 'Offset', type: 'number', default: '20', unit: 'mm', show: (p) => p.mode !== 'mid' },
      { key: 'axis', label: 'Rotate about', type: 'select', options: [['x', 'Plane X axis'], ['y', 'Plane Y axis']], default: 'x', show: (p) => p.mode === 'angle' },
      { key: 'angle', label: 'Angle', type: 'number', default: '45', unit: '°', show: (p) => p.mode === 'angle' },
    ],
  },
  presspull: {
    label: 'Press Pull', icon: 'presspull', group: 'modify', key: 'Q',
    fields: [
      { key: 'faces', label: 'Faces', type: 'faces', hint: 'Click planar faces' },
      { key: 'distance', label: 'Distance', type: 'number', default: '5', unit: 'mm' },
    ],
  },
  draft: {
    label: 'Draft', icon: 'draft', group: 'modify',
    fields: [
      { key: 'faces', label: 'Faces', type: 'faces', hint: 'Click faces to taper' },
      { key: 'plane', label: 'Neutral plane', type: 'planeRef', default: { type: 'std', name: 'XY' } },
      { key: 'angle', label: 'Angle', type: 'number', default: '3', unit: '°' },
    ],
  },
  split: {
    label: 'Split Body', icon: 'split', group: 'modify',
    fields: [
      { key: 'body', label: 'Body to split', type: 'body' },
      { key: 'plane', label: 'Splitting plane', type: 'planeRef', default: { type: 'std', name: 'XY' } },
    ],
  },
  component: {
    label: 'Component', icon: 'component', group: 'assemble',
    fields: [
      { key: 'x', label: 'X', type: 'number', default: '0', unit: 'mm' },
      { key: 'y', label: 'Y', type: 'number', default: '0', unit: 'mm' },
      { key: 'z', label: 'Z', type: 'number', default: '0', unit: 'mm' },
      { key: 'rx', label: 'Rotate X', type: 'number', default: '0', unit: '°' },
      { key: 'ry', label: 'Rotate Y', type: 'number', default: '0', unit: '°' },
      { key: 'rz', label: 'Rotate Z', type: 'number', default: '0', unit: '°' },
      { key: 'grounded', label: 'Grounded', type: 'check', default: false },
    ],
  },
  joint: {
    label: 'Joint', icon: 'joint', group: 'assemble', key: 'J',
    fields: [
      { key: 'moving', label: 'Moving face', type: 'face1', hint: 'Face on the part to move' },
      { key: 'fixed', label: 'Target face', type: 'face1', hint: 'Face to attach it to' },
      { key: 'type', label: 'Motion', type: 'select', options: [['rigid', 'Rigid'], ['revolute', 'Revolute'], ['slider', 'Slider']], default: 'rigid' },
      { key: 'angle', label: 'Angle', type: 'number', default: '0', unit: '°' },
      { key: 'offset', label: 'Offset', type: 'number', default: '0', unit: 'mm' },
      { key: 'flip', label: 'Flip', type: 'check', default: false },
    ],
  },
  fastener: {
    label: 'Fastener', icon: 'fastener', group: 'insert',
    fields: [
      { key: 'face', label: 'Hole or face', type: 'face1', hint: 'Click the wall of a hole (near the end the head goes) or a flat face' },
      { key: 'kind', label: 'Type', type: 'select', options: [['shcs', 'Socket head cap screw (ISO 4762)'], ['hexbolt', 'Hexagon head bolt (ISO 4017)'], ['csk', 'Countersunk screw (ISO 10642)'], ['nut', 'Hexagon nut (ISO 4032)'], ['washer', 'Plain washer (ISO 7089)']], default: 'shcs' },
      { key: 'size', label: 'Size', type: 'select', options: [['M2', 'M2'], ['M2.5', 'M2.5'], ['M3', 'M3'], ['M4', 'M4'], ['M5', 'M5'], ['M6', 'M6'], ['M8', 'M8'], ['M10', 'M10'], ['M12', 'M12'], ['M14', 'M14'], ['M16', 'M16'], ['M20', 'M20'], ['M24', 'M24']], default: 'M6' },
      { key: 'length', label: 'Length', type: 'number', default: '20', unit: 'mm', show: (p) => !['nut', 'washer'].includes(p.kind) },
      { key: 'flip', label: 'Flip', type: 'check', default: false },
    ],
  },
  thread: {
    label: 'Thread', icon: 'thread', group: 'create',
    fields: [
      { key: 'face', label: 'Face', type: 'face1', hint: 'Click a shaft or hole' },
      { key: 'size', label: 'Size', type: 'select', options: [['M2', 'M2 × 0.4'], ['M2.5', 'M2.5 × 0.45'], ['M3', 'M3 × 0.5'], ['M4', 'M4 × 0.7'], ['M5', 'M5 × 0.8'], ['M6', 'M6 × 1'], ['M8', 'M8 × 1.25'], ['M10', 'M10 × 1.5'], ['M12', 'M12 × 1.75'], ['M14', 'M14 × 2'], ['M16', 'M16 × 2'], ['M20', 'M20 × 2.5'], ['M24', 'M24 × 3'], ['M30', 'M30 × 3.5'], ['custom', 'Custom pitch']], default: 'M10' },
      { key: 'pitch', label: 'Pitch', type: 'number', default: '1.5', unit: 'mm', show: (p) => p.size === 'custom' },
      { key: 'full', label: 'Full length', type: 'check', default: true },
      { key: 'length', label: 'Length', type: 'number', default: '10', unit: 'mm', show: (p) => !p.full },
      { key: 'offset', label: 'Start offset', type: 'number', default: '0', unit: 'mm' },
      { key: 'hand', label: 'Hand', type: 'select', options: [['right', 'Right'], ['left', 'Left']], default: 'right' },
      { key: 'flip', label: 'Start from other end', type: 'check', default: false },
    ],
  },
  coil: {
    label: 'Coil', icon: 'coil', group: 'create',
    fields: [
      { key: 'radius', label: 'Coil radius', type: 'number', default: '10', unit: 'mm' },
      { key: 'pitch', label: 'Pitch', type: 'number', default: '5', unit: 'mm' },
      { key: 'turns', label: 'Turns', type: 'number', default: '6' },
      { key: 'section', label: 'Wire diameter', type: 'number', default: '2', unit: 'mm' },
      { key: 'axis', label: 'Axis', type: 'select', options: AXIS3, default: 'Z' },
      { key: 'hand', label: 'Hand', type: 'select', options: [['right', 'Right'], ['left', 'Left']], default: 'right' },
      ...POS, OP, TARGET,
    ],
  },
  sheetbase: {
    label: 'Sheet Metal Base', icon: 'sheetbase', group: 'sheet',
    fields: [
      { key: 'sketch', label: 'Sketch', type: 'sketch' },
      { key: 'profiles', label: 'Profile', type: 'regions', of: 'sketch' },
      { key: 'thickness', label: 'Thickness', type: 'number', default: '1.5', unit: 'mm' },
      { key: 'bendRadius', label: 'Bend radius (inside)', type: 'number', default: '1.5', unit: 'mm' },
      { key: 'kfactor', label: 'K-factor', type: 'number', default: '0.44' },
      { key: 'flip', label: 'Flip thickness side', type: 'check', default: false },
    ],
  },
  flange: {
    label: 'Flange', icon: 'flange', group: 'sheet',
    fields: [
      { key: 'edges', label: 'Edges', type: 'edges', hint: 'Click straight outside edges of the plate or of a flange' },
      { key: 'length', label: 'Length after bend', type: 'number', default: '20', unit: 'mm' },
      { key: 'angle', label: 'Bend angle', type: 'number', default: '90', unit: '°' },
      { key: 'dir', label: 'Direction', type: 'select', options: [['up', 'Up (thickness side)'], ['down', 'Down']], default: 'up' },
      { key: 'inset', label: 'Inset from corners', type: 'number', default: '0', unit: 'mm' },
    ],
  },
  text: {
    label: 'Text', icon: 'text', group: 'create',
    fields: [
      { key: 'plane', label: 'Plane or face', type: 'planeRef', default: { type: 'std', name: 'XY' } },
      { key: 'text', label: 'Text', type: 'string', default: 'RUFFLE3D' },
      { key: 'font', label: 'Font', type: 'font', default: 'builtin' },
      { key: 'weight', label: 'Stroke', type: 'select', options: [['thin', 'Thin'], ['regular', 'Regular'], ['bold', 'Bold']], default: 'regular', show: (p) => !p.font || p.font === 'builtin' },
      { key: 'height', label: 'Height', type: 'number', default: '10', unit: 'mm' },
      { key: 'align', label: 'Align', type: 'select', options: [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], default: 'center' },
      { key: 'x', label: 'Position X', type: 'number', default: '0', unit: 'mm' },
      { key: 'y', label: 'Position Y', type: 'number', default: '0', unit: 'mm' },
      { key: 'angle', label: 'Rotation', type: 'number', default: '0', unit: '°' },
      { key: 'spacing', label: 'Extra spacing', type: 'number', default: '0', unit: 'mm' },
      { key: 'depth', label: 'Depth', type: 'number', default: '1', unit: 'mm' },
      { key: 'op', label: 'Operation', type: 'select', options: [['new', 'New body'], ['join', 'Emboss (join)'], ['cut', 'Engrave (cut)']], default: 'new' },
      TARGET,
    ],
  },
  remove: {
    label: 'Remove', icon: 'remove', group: 'modify',
    fields: [{ key: 'bodies', label: 'Bodies', type: 'bodies' }],
  },
  import: { label: 'Import', icon: 'import', group: 'insert', fields: [] },

  // ---------- free-form NURBS ----------
  cvcurve: {
    label: 'CV Curve', icon: 'cvcurve', group: 'curve',
    fields: [
      { key: 'degree', label: 'Degree', type: 'select', options: [['1', '1'], ['2', '2'], ['3', '3'], ['5', '5']], default: '3' },
      { key: 'closed', label: 'Closed (periodic)', type: 'check', default: false },
    ],
  },
  cvsurface: {
    label: 'CV Surface', icon: 'cvsurface', group: 'surface',
    fields: [
      { key: 'source', label: 'Create from', type: 'select', options: [['plane', 'CV plane'], ['face', 'Rebuild a face']], default: 'plane' },
      { key: 'plane', label: 'Plane', type: 'planeRef', default: { type: 'std', name: 'XY' }, show: (p) => p.source !== 'face' },
      { key: 'w', label: 'Width', type: 'number', default: '60', unit: 'mm', show: (p) => p.source !== 'face' },
      { key: 'l', label: 'Length', type: 'number', default: '60', unit: 'mm', show: (p) => p.source !== 'face' },
      { key: 'face', label: 'Face', type: 'face1', hint: 'Face to rebuild', show: (p) => p.source === 'face' },
      { key: 'method', label: 'Method', type: 'select', options: [['exact', 'Exact'], ['fit', 'Refit']], default: 'exact', show: (p) => p.source === 'face' },
      { key: 'replace', label: 'Replace original', type: 'check', default: true, show: (p) => p.source === 'face' },
      { key: 'nu', label: 'CVs in U', type: 'int', default: '5', show: (p) => p.source !== 'face' || p.method === 'fit' },
      { key: 'nv', label: 'CVs in V', type: 'int', default: '5', show: (p) => p.source !== 'face' || p.method === 'fit' },
      { key: 'degree', label: 'Degree', type: 'select', options: [['1', '1'], ['2', '2'], ['3', '3'], ['5', '5']], default: '3', show: (p) => p.source !== 'face' || p.method === 'fit' },
    ],
  },
  surffillet: {
    label: 'Surface Fillet', icon: 'surffillet', group: 'surface',
    fields: [
      { key: 'a', label: 'Surface 1', type: 'face1', hint: 'Click the part to keep' },
      { key: 'b', label: 'Surface 2', type: 'face1', hint: 'Click the part to keep' },
      { key: 'size', label: 'Size by', type: 'select', options: [['radius', 'Radius'], ['chord', 'Chord length']], default: 'radius' },
      { key: 'rmode', label: 'Profile', type: 'select', options: [['constant', 'Constant'], ['variable', 'Variable']], default: 'constant' },
      { key: 'law', label: 'Law', type: 'select', options: [['linear', 'Linear'], ['smooth', 'Smooth (S-curve)'], ['mid', 'Through a middle value']], default: 'linear', show: (p) => p.rmode === 'variable' },
      { key: 'radius', label: 'Start size', type: 'number', default: '5', unit: 'mm' },
      { key: 'radiusMid', label: 'Middle size', type: 'number', default: '8', unit: 'mm', show: (p) => p.rmode === 'variable' && p.law === 'mid' },
      { key: 'radius2', label: 'End size', type: 'number', default: '10', unit: 'mm', show: (p) => p.rmode === 'variable' },
      { key: 'flip', label: 'Swap ends', type: 'check', default: false, show: (p) => p.rmode === 'variable' },
    ],
  },
  surftrim: {
    label: 'Trim', icon: 'surftrim', group: 'surface',
    fields: [
      { key: 'target', label: 'Surface', type: 'face1', hint: 'Click the region to keep / remove' },
      { key: 'sketch', label: 'Trim curve', type: 'sketch', curve: true },
      { key: 'mode', label: 'Clicked region', type: 'select', options: [['keep', 'Keep'], ['remove', 'Remove']], default: 'keep' },
      { key: 'dir', label: 'Project along', type: 'select', options: [['', 'Curve plane normal'], ['view', 'Current view'], ['X', 'World X'], ['Y', 'World Y'], ['Z', 'World Z']], default: '' },
    ],
  },

  // ---------- surface modelling (open shells / NURBS faces) ----------
  surfextrude: {
    label: 'Extrude Surface', icon: 'surfextrude', group: 'surface',
    fields: [
      { key: 'sketch', label: 'Curves', type: 'sketch', curve: true },
      { key: 'side', label: 'Direction', type: 'select', options: [['one', 'One side'], ['symmetric', 'Symmetric']], default: 'one' },
      { key: 'dir', label: 'Along', type: 'select', options: [['', 'Curve plane normal'], ['X', 'World X'], ['Y', 'World Y'], ['Z', 'World Z']], default: '' },
      { key: 'distance', label: 'Distance', type: 'number', default: '20', unit: 'mm' },
    ],
  },
  surfrevolve: {
    label: 'Revolve Surface', icon: 'surfrevolve', group: 'surface',
    fields: [
      { key: 'sketch', label: 'Curves', type: 'sketch', curve: true },
      { key: 'axis', label: 'Axis', type: 'select', options: [['sy', 'Sketch vertical axis'], ['sx', 'Sketch horizontal axis'], ['X', 'World X'], ['Y', 'World Y'], ['Z', 'World Z']], default: 'sy' },
      { key: 'angle', label: 'Angle', type: 'number', default: '360', unit: '°' },
    ],
  },
  surfloft: {
    label: 'Skin Surface', icon: 'surfloft', group: 'surface',
    fields: [
      { key: 'sections', label: 'Sections', type: 'curves', hint: 'Click curves in order' },
      { key: 'ruled', label: 'Ruled (straight)', type: 'check', default: false },
    ],
  },
  surfsweep: {
    label: 'Rail Surface', icon: 'surfsweep', group: 'surface',
    fields: [
      { key: 'sketch', label: 'Profile', type: 'sketch', curve: true },
      { key: 'path', label: 'Rail', type: 'sketch', curve: true },
      { key: 'orient', label: 'Orientation', type: 'select', options: [['frenet', 'Follow rail'], ['fixed', 'Fixed']], default: 'frenet' },
    ],
  },
  patch: {
    label: 'Boundary Patch', icon: 'patch', group: 'surface',
    fields: [
      { key: 'sections', label: 'Boundary curves', type: 'curves', hint: 'Click sketch curves' },
      { key: 'edges', label: 'Boundary edges', type: 'edges', hint: 'Optional: model edges' },
      { key: 'cont', label: 'Continuity', type: 'select', options: [['G0', 'G0 Position'], ['G1', 'G1 Tangent']], default: 'G0' },
    ],
  },
  surfoffset: {
    label: 'Offset Surface', icon: 'surfoffset', group: 'surface',
    fields: [
      { key: 'faces', label: 'Faces', type: 'faces', hint: 'Click faces to offset' },
      { key: 'distance', label: 'Distance', type: 'number', default: '5', unit: 'mm' },
    ],
  },
  thicken: {
    label: 'Thicken', icon: 'thicken', group: 'surface',
    fields: [
      { key: 'body', label: 'Surface', type: 'body' },
      { key: 'thickness', label: 'Thickness', type: 'number', default: '2', unit: 'mm' },
      { key: 'side', label: 'Direction', type: 'select', options: [['out', 'Outside'], ['in', 'Inside'], ['both', 'Symmetric']], default: 'out' },
    ],
  },
  stitch: {
    label: 'Stitch', icon: 'stitch', group: 'surface',
    fields: [
      { key: 'bodies', label: 'Surfaces', type: 'bodies' },
      { key: 'tolerance', label: 'Tolerance', type: 'number', default: '0.01', unit: 'mm' },
    ],
  },
};

export function defaultsFor(type, ctx) {
  const p = {};
  for (const f of FEATURES[type].fields) {
    if (f.default !== undefined) p[f.key] = typeof f.default === 'object' ? structuredClone(f.default) : f.default;
    else if (f.type === 'regions' || f.type === 'face1' || f.type === 'curves') p[f.key] = [];
    else if (f.type === 'sketch') p[f.key] = f.key === 'sketch2' || f.key === 'path' ? ctx.prevSketch || '' : ctx.lastSketch || '';
    else if (f.type === 'body') p[f.key] = ctx.lastBody || '';
    else if (['bodies', 'edges', 'faces', 'points'].includes(f.type)) p[f.key] = f.type === 'bodies' && ctx.selectedBodies?.length ? ctx.selectedBodies.slice() : [];
  }
  return p;
}

// Feature types that create a body via an operation field
export const hasOp = (type) => FEATURES[type].fields.some((f) => f.key === 'op');

// Physical materials (density in g/cm³ + default look), appearance presets, finishes and colour palettes.

// Physical materials drive mass properties and the body's default appearance.
export const MATERIALS = {
  // metals
  aluminum: { name: 'Aluminum 6061', cat: 'Metal', density: 2.7, color: '#b9c0c8', metalness: 0.9, roughness: 0.32 },
  aluminum7075: { name: 'Aluminum 7075', cat: 'Metal', density: 2.81, color: '#aeb5bd', metalness: 0.9, roughness: 0.36 },
  steel: { name: 'Steel', cat: 'Metal', density: 7.85, color: '#8f979f', metalness: 0.9, roughness: 0.34 },
  stainless: { name: 'Stainless Steel', cat: 'Metal', density: 8.0, color: '#c6cacd', metalness: 0.95, roughness: 0.22 },
  castiron: { name: 'Cast Iron', cat: 'Metal', density: 7.2, color: '#5f6366', metalness: 0.7, roughness: 0.7 },
  brass: { name: 'Brass', cat: 'Metal', density: 8.5, color: '#d2a64e', metalness: 1, roughness: 0.26 },
  bronze: { name: 'Bronze', cat: 'Metal', density: 8.8, color: '#b0773f', metalness: 1, roughness: 0.32 },
  copper: { name: 'Copper', cat: 'Metal', density: 8.96, color: '#d08455', metalness: 1, roughness: 0.28 },
  titanium: { name: 'Titanium', cat: 'Metal', density: 4.43, color: '#9d9c95', metalness: 0.85, roughness: 0.38 },
  gold: { name: 'Gold', cat: 'Metal', density: 19.3, color: '#f2c35b', metalness: 1, roughness: 0.18 },
  // plastics
  abs: { name: 'ABS Plastic', cat: 'Plastic', density: 1.04, color: '#ecebe6', metalness: 0, roughness: 0.55 },
  pla: { name: 'PLA (Blue)', cat: 'Plastic', density: 1.24, color: '#2f7fd8', metalness: 0, roughness: 0.5 },
  petg: { name: 'PETG', cat: 'Plastic', density: 1.27, color: '#3b3f46', metalness: 0, roughness: 0.35, clearcoat: 0.3 },
  pc: { name: 'Polycarbonate', cat: 'Plastic', density: 1.2, color: '#d9e6ee', metalness: 0, roughness: 0.08, opacity: 0.55, clearcoat: 1 },
  acrylic: { name: 'Acrylic (PMMA)', cat: 'Plastic', density: 1.18, color: '#e9f4fb', metalness: 0, roughness: 0.04, opacity: 0.4, clearcoat: 1 },
  nylon: { name: 'Nylon PA12', cat: 'Plastic', density: 1.14, color: '#efece2', metalness: 0, roughness: 0.68 },
  pom: { name: 'Acetal (POM)', cat: 'Plastic', density: 1.41, color: '#f6f5f0', metalness: 0, roughness: 0.4 },
  ptfe: { name: 'PTFE', cat: 'Plastic', density: 2.2, color: '#f3f2ee', metalness: 0, roughness: 0.75 },
  // elastomers
  rubber: { name: 'Rubber', cat: 'Elastomer', density: 1.1, color: '#2b2b2b', metalness: 0, roughness: 0.92 },
  silicone: { name: 'Silicone', cat: 'Elastomer', density: 1.1, color: '#e4573d', metalness: 0, roughness: 0.6, sheen: 0.6 },
  tpu: { name: 'TPU', cat: 'Elastomer', density: 1.21, color: '#30343a', metalness: 0, roughness: 0.7 },
  // other
  oak: { name: 'Oak Wood', cat: 'Natural', density: 0.75, color: '#b07a45', metalness: 0, roughness: 0.75 },
  walnut: { name: 'Walnut', cat: 'Natural', density: 0.65, color: '#6b4428', metalness: 0, roughness: 0.6, clearcoat: 0.4 },
  glass: { name: 'Glass', cat: 'Natural', density: 2.5, color: '#bfe3f0', metalness: 0, roughness: 0.03, opacity: 0.35, clearcoat: 1 },
  ceramic: { name: 'Ceramic', cat: 'Natural', density: 3.9, color: '#f1efe9', metalness: 0, roughness: 0.2, clearcoat: 0.8 },
  concrete: { name: 'Concrete', cat: 'Natural', density: 2.4, color: '#9a9893', metalness: 0, roughness: 0.95 },
  carbon: { name: 'Carbon Fiber', cat: 'Composite', density: 1.6, color: '#2c2f33', metalness: 0.4, roughness: 0.35, clearcoat: 1 },
  fr4: { name: 'FR4 (PCB)', cat: 'Composite', density: 1.85, color: '#1f6b3a', metalness: 0, roughness: 0.45, clearcoat: 0.5 },
};
export const DEFAULT_MATERIAL = 'aluminum';

// Mechanical properties for stress analysis: Young's modulus E and strength in MPa, Poisson's ratio nu,
// thermal conductivity k in W/(m·K).
// Strength is the yield strength for metals and plastics, and a typical tensile or bending strength for
// brittle and natural materials (flagged brittle). Values are typical room-temperature figures.
export const MECHANICAL = {
  aluminum: { E: 68900, nu: 0.33, yield: 276, k: 167 },
  aluminum7075: { E: 71700, nu: 0.33, yield: 503, k: 130 },
  steel: { E: 200000, nu: 0.29, yield: 350, k: 50 },
  stainless: { E: 193000, nu: 0.29, yield: 215, k: 16 },
  castiron: { E: 110000, nu: 0.26, yield: 200, brittle: true, k: 52 },
  brass: { E: 100000, nu: 0.34, yield: 250, k: 120 },
  bronze: { E: 110000, nu: 0.34, yield: 240, k: 60 },
  copper: { E: 117000, nu: 0.34, yield: 200, k: 390 },
  titanium: { E: 113800, nu: 0.34, yield: 880, k: 7 },
  gold: { E: 79000, nu: 0.42, yield: 120, k: 315 },
  abs: { E: 2300, nu: 0.35, yield: 40, k: 0.17 },
  pla: { E: 3500, nu: 0.36, yield: 50, k: 0.13 },
  petg: { E: 2100, nu: 0.38, yield: 50, k: 0.2 },
  pc: { E: 2400, nu: 0.37, yield: 62, k: 0.2 },
  acrylic: { E: 3200, nu: 0.37, yield: 70, brittle: true, k: 0.19 },
  nylon: { E: 1700, nu: 0.39, yield: 45, k: 0.25 },
  pom: { E: 2900, nu: 0.35, yield: 65, k: 0.31 },
  ptfe: { E: 500, nu: 0.46, yield: 20, k: 0.25 },
  rubber: { E: 50, nu: 0.49, yield: 15, k: 0.16 },
  silicone: { E: 5, nu: 0.48, yield: 7, k: 0.2 },
  tpu: { E: 50, nu: 0.45, yield: 25, k: 0.2 },
  oak: { E: 11000, nu: 0.3, yield: 40, brittle: true, k: 0.17 },
  walnut: { E: 11600, nu: 0.3, yield: 50, brittle: true, k: 0.15 },
  glass: { E: 70000, nu: 0.22, yield: 50, brittle: true, k: 1 },
  ceramic: { E: 300000, nu: 0.22, yield: 300, brittle: true, k: 30 },
  concrete: { E: 30000, nu: 0.2, yield: 3, brittle: true, k: 1.7 },
  carbon: { E: 70000, nu: 0.3, yield: 600, brittle: true, k: 5 },
  fr4: { E: 22000, nu: 0.14, yield: 300, brittle: true, k: 0.3 },
};
export const MATERIAL_CATS = ['Metal', 'Plastic', 'Elastomer', 'Natural', 'Composite'];

// Surface finishes: applied on top of a colour.
export const FINISHES = {
  matte: { name: 'Matte', metalness: 0, roughness: 0.85 },
  satin: { name: 'Satin', metalness: 0, roughness: 0.5 },
  gloss: { name: 'Gloss', metalness: 0, roughness: 0.22, clearcoat: 0.6 },
  paint: { name: 'Car paint', metalness: 0.45, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.04 },
  metallic: { name: 'Metallic', metalness: 0.9, roughness: 0.32 },
  brushed: { name: 'Brushed', metalness: 0.9, roughness: 0.48 },
  anodized: { name: 'Anodized', metalness: 0.75, roughness: 0.36 },
  chrome: { name: 'Chrome', metalness: 1, roughness: 0.04 },
  soft: { name: 'Soft touch', metalness: 0, roughness: 0.95, sheen: 0.5 },
  clear: { name: 'Transparent', metalness: 0, roughness: 0.04, opacity: 0.4, clearcoat: 1 },
};

// Ready-made appearances (look only — the physical material, and so the mass, is unchanged).
export const APPEARANCES = {
  Paint: [
    ['Racing Red', '#d0202a', 'paint'], ['Signal Orange', '#f2652a', 'paint'], ['Sun Yellow', '#f5c518', 'gloss'], ['Lime', '#8cc63f', 'gloss'],
    ['British Green', '#1f5a3a', 'paint'], ['Ocean Blue', '#1764c4', 'paint'], ['Midnight', '#1b2440', 'paint'], ['Royal Purple', '#5b2f91', 'paint'],
    ['Pearl White', '#f2f1ec', 'paint'], ['Graphite', '#3a3d42', 'paint'], ['Gloss Black', '#0f1012', 'gloss'], ['Pastel Mint', '#a6e3c7', 'satin'],
  ],
  Metal: [
    ['Polished Aluminum', '#d4d8dd', 'chrome'], ['Brushed Aluminum', '#b9bfc6', 'brushed'], ['Chrome', '#e8ebee', 'chrome'], ['Gunmetal', '#4a4e54', 'metallic'],
    ['Anodized Blue', '#2a6fd0', 'anodized'], ['Anodized Red', '#c2283a', 'anodized'], ['Anodized Black', '#22252a', 'anodized'], ['Anodized Gold', '#d0a34a', 'anodized'],
    ['Copper', '#d08455', 'metallic'], ['Brass', '#d2a64e', 'metallic'], ['Rose Gold', '#e2a68f', 'metallic'], ['Titanium', '#8e8d86', 'brushed'],
  ],
  Plastic: [
    ['White ABS', '#efeee9', 'satin'], ['Black ABS', '#1c1d20', 'satin'], ['Grey ABS', '#8a8f96', 'satin'], ['Matte Black', '#16171a', 'matte'],
    ['Signal Red', '#d9302c', 'satin'], ['Safety Yellow', '#f2c21b', 'satin'], ['Sky Blue', '#4aa3e8', 'satin'], ['Teal', '#14a39a', 'satin'],
    ['Soft-touch Grey', '#5b5f66', 'soft'], ['Clear', '#e9f4fb', 'clear'], ['Smoke', '#4a525c', 'clear'], ['Tinted Blue', '#7fb7e6', 'clear'],
  ],
  Other: [
    ['Rubber', '#262626', 'matte'], ['Oak', '#b07a45', 'satin'], ['Walnut', '#6b4428', 'gloss'], ['Concrete', '#9a9893', 'matte'],
    ['Ceramic', '#f1efe9', 'gloss'], ['Carbon', '#24272b', 'paint'], ['PCB Green', '#1f6b3a', 'gloss'], ['Cork', '#c49a6c', 'matte'],
  ],
};

// Quick colour swatches for custom appearances.
export const PALETTE = [
  '#f2f1ec', '#c9ced4', '#8a8f96', '#4a4e54', '#22252a', '#0f1012',
  '#d0202a', '#f2652a', '#f5a524', '#f5c518', '#8cc63f', '#2fb56b',
  '#14a39a', '#22b8e6', '#1764c4', '#3f51d6', '#5b2f91', '#c2378f',
  '#f28fb0', '#e2a68f', '#d2a64e', '#b07a45', '#6b4428', '#1f5a3a',
];

// Interface accent colours (Preferences → General).
export const ACCENTS = {
  blue: ['Blue', '#4f8cff', '#2f6bff'], violet: ['Violet', '#8b6cff', '#6d4aff'], teal: ['Teal', '#22c3b5', '#0f9d92'],
  green: ['Green', '#3ecf6e', '#1fa34c'], amber: ['Amber', '#f5a524', '#d98a00'], orange: ['Orange', '#ff7a3d', '#e85d1c'],
  rose: ['Rose', '#f5527a', '#e0335e'], graphite: ['Graphite', '#9aa5b5', '#5d6878'],
};

// Toolbar / timeline category colours.
export const CATEGORY_COLORS = { sketch: '#f2994a', create: '#4f8cff', modify: '#3ecf8e', construct: '#b07cff', surface: '#e46ee8', curve: '#fb7185', assemble: '#2dd4bf', inspect: '#f5a524', insert: '#8a9bb0', sheet: '#38bdf8' };

// Look of a body: physical material defaults, then any appearance override (meta.look; legacy meta.color).
export function bodyLook(meta) {
  const mat = MATERIALS[meta.material] || MATERIALS[DEFAULT_MATERIAL];
  const base = { name: mat.name, color: mat.color, metalness: mat.metalness, roughness: mat.roughness, opacity: mat.opacity ?? 1, clearcoat: mat.clearcoat || 0, sheen: mat.sheen || 0 };
  const o = meta.look || (meta.color ? { color: meta.color } : null);
  return o ? { ...base, ...o } : base;
}

// Builds a look object from a colour + finish key.
export function makeLook(color, finish = 'satin', name) {
  const f = FINISHES[finish] || FINISHES.satin;
  return { name: name || `${f.name} ${color}`, color, finish, metalness: f.metalness, roughness: f.roughness, opacity: f.opacity ?? 1, clearcoat: f.clearcoat || 0, clearcoatRoughness: f.clearcoatRoughness ?? 0.1, sheen: f.sheen || 0 };
}

// CSS preview ball for a look.
export function lookBall(l) {
  const hi = l.metalness > 0.5 ? '#ffffffd0' : l.roughness < 0.3 ? '#ffffffb8' : '#ffffff60';
  const lo = l.metalness > 0.5 ? '#000c' : '#0008';
  return `radial-gradient(circle at 34% 28%, ${hi} 0, ${l.color} ${l.roughness < 0.3 ? 30 : 46}%, ${lo} 100%)`;
}

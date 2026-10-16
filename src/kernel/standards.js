// Standard metric fastener and hole dimensions (mm), used by the hole wizard and the fastener library.
// Values are the usual nominal figures from the ISO standards named; check critical parts against
// your fastener supplier's data.

export const METRIC_SIZES = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M14', 'M16', 'M20', 'M24'];

// coarse pitch (ISO 261)
export const PITCH = { M2: 0.4, 'M2.5': 0.45, M3: 0.5, M4: 0.7, M5: 0.8, M6: 1, M8: 1.25, M10: 1.5, M12: 1.75, M14: 2, M16: 2, M20: 2.5, M24: 3 };
export const NOMINAL = Object.fromEntries(METRIC_SIZES.map((s) => [s, parseFloat(s.slice(1))]));

// clearance holes (ISO 273): fine, medium, coarse series
export const CLEARANCE = {
  M2: [2.2, 2.4, 2.6], 'M2.5': [2.7, 2.9, 3.1], M3: [3.2, 3.4, 3.6], M4: [4.3, 4.5, 4.8], M5: [5.3, 5.5, 5.8], M6: [6.4, 6.6, 7],
  M8: [8.4, 9, 10], M10: [10.5, 11, 12], M12: [13, 13.5, 14.5], M14: [15, 15.5, 16.5], M16: [17, 17.5, 18.5], M20: [21, 22, 24], M24: [25, 26, 28],
};
export const FIT_INDEX = { close: 0, normal: 1, loose: 2 };

// socket head cap screws (ISO 4762): head diameter dk, head height k (= d), hex socket s
export const ISO4762 = {
  M2: { dk: 3.8, k: 2, s: 1.5 }, 'M2.5': { dk: 4.5, k: 2.5, s: 2 }, M3: { dk: 5.5, k: 3, s: 2.5 }, M4: { dk: 7, k: 4, s: 3 }, M5: { dk: 8.5, k: 5, s: 4 },
  M6: { dk: 10, k: 6, s: 5 }, M8: { dk: 13, k: 8, s: 6 }, M10: { dk: 16, k: 10, s: 8 }, M12: { dk: 18, k: 12, s: 10 }, M14: { dk: 21, k: 14, s: 12 },
  M16: { dk: 24, k: 16, s: 14 }, M20: { dk: 30, k: 20, s: 17 }, M24: { dk: 36, k: 24, s: 19 },
};
// counterbores for ISO 4762 heads (DIN 974-1, row 1): diameter and depth
export const CBORE_4762 = {
  M2: [4.4, 2.4], 'M2.5': [5.5, 2.9], M3: [6.5, 3.4], M4: [8, 4.4], M5: [10, 5.4], M6: [11, 6.4], M8: [15, 8.6],
  M10: [18, 10.6], M12: [20, 12.6], M14: [24, 14.6], M16: [26, 16.6], M20: [33, 20.6], M24: [40, 24.8],
};
// countersunk (flat) head screws (ISO 10642, 90°): head diameter; the countersink is made slightly larger
export const ISO10642_DK = { M2: 4.4, 'M2.5': 5.5, M3: 6.72, M4: 8.96, M5: 11.2, M6: 13.44, M8: 17.92, M10: 22.4, M12: 26.88, M14: 30.8, M16: 33.6, M20: 40.32, M24: 48 };
// hexagon head bolts and nuts: width across flats s, bolt head height k (ISO 4017), nut height m (ISO 4032)
export const HEX = {
  M2: { s: 4, k: 1.4, m: 1.6 }, 'M2.5': { s: 5, k: 1.7, m: 2 }, M3: { s: 5.5, k: 2, m: 2.4 }, M4: { s: 7, k: 2.8, m: 3.2 }, M5: { s: 8, k: 3.5, m: 4.7 },
  M6: { s: 10, k: 4, m: 5.2 }, M8: { s: 13, k: 5.3, m: 6.8 }, M10: { s: 16, k: 6.4, m: 8.4 }, M12: { s: 18, k: 7.5, m: 10.8 }, M14: { s: 21, k: 8.8, m: 12.8 },
  M16: { s: 24, k: 10, m: 14.8 }, M20: { s: 30, k: 12.5, m: 18 }, M24: { s: 36, k: 15, m: 21.5 },
};
// plain washers (ISO 7089): inner diameter, outer diameter, thickness
export const WASHER = {
  M2: [2.2, 5, 0.3], 'M2.5': [2.7, 6, 0.5], M3: [3.2, 7, 0.5], M4: [4.3, 9, 0.8], M5: [5.3, 10, 1], M6: [6.4, 12, 1.6], M8: [8.4, 16, 1.6],
  M10: [10.5, 20, 2], M12: [13, 24, 2.5], M14: [15, 28, 2.5], M16: [17, 30, 3], M20: [21, 37, 3], M24: [25, 44, 4],
};

/** The hole a standard calls for: { diameter, tapped, tapSize, cbore, cboreD, cboreDepth, csink, csinkD }. */
export function standardHole(standard, size, fit = 'normal') {
  if (!NOMINAL[size]) throw new Error(`Unknown size ${size}`);
  const clear = CLEARANCE[size][FIT_INDEX[fit] ?? 1];
  if (standard === 'clearance') return { diameter: clear, tapped: false, cbore: false, csink: false };
  if (standard === 'cbore') { const [D, depth] = CBORE_4762[size]; return { diameter: clear, tapped: false, cbore: true, cboreD: D, cboreDepth: depth, csink: false }; }
  if (standard === 'csink') return { diameter: clear, tapped: false, cbore: false, csink: true, csinkD: +(ISO10642_DK[size] + 0.3).toFixed(2) };
  if (standard === 'tapped') return { tapped: true, tapSize: size, cbore: false, csink: false };
  throw new Error(`Unknown hole type ${standard}`);
}

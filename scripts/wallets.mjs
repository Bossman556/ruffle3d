// Checks crypto wallet addresses before they are published: Ethereum addresses against their EIP-55
// mixed-case checksum, Bitcoin addresses against their bech32 / bech32m checksum. A typo in a donation
// address would send money nowhere, so the website build refuses to publish one that fails.
import { keccak_256 } from '@noble/hashes/sha3';

export function checkEth(addr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return 'not a 0x address with 40 hex digits';
  const hex = addr.slice(2), lower = hex.toLowerCase();
  if (hex === lower || hex === hex.toUpperCase()) return null; // no checksum to check
  const hash = Buffer.from(keccak_256(new TextEncoder().encode(lower))).toString('hex');
  for (let i = 0; i < 40; i++) {
    const want = parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
    if (hex[i] !== want) return `EIP-55 checksum fails at character ${i + 3}`;
  }
  return null;
}

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i]; }
  return chk >>> 0;
}
export function checkBtc(addr) {
  const a = addr.toLowerCase();
  if (addr !== a && addr !== addr.toUpperCase()) return 'mixed case';
  const pos = a.lastIndexOf('1');
  if (!a.startsWith('bc1') || pos < 2 || a.length - pos < 7) return 'not a bc1 (native SegWit) address';
  const hrp = a.slice(0, pos), data = [...a.slice(pos + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) return 'contains a character bech32 does not use';
  const pm = polymod([...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...data]);
  const version = data[0];
  if (pm !== (version === 0 ? 1 : 0x2bc830a3)) return 'bech32 checksum fails';
  return null;
}

// Test helpers: tiny ZIP writer and ELF64 .so stub (for APK/AAB fixtures).
import zlib from 'node:zlib';

/** Minimal ELF64 little-endian shared object with one PT_LOAD of the given alignment. */
export function elf(align) {
  const b = Buffer.alloc(64 + 56);
  b.writeUInt32BE(0x7f454c46, 0); b[4] = 2; b[5] = 1; b[6] = 1;
  b.writeUInt16LE(3, 16); b.writeUInt16LE(183, 18);
  b.writeBigUInt64LE(64n, 32); b.writeUInt16LE(56, 54); b.writeUInt16LE(1, 56);
  b.writeUInt32LE(1, 64); b.writeBigUInt64LE(BigInt(align), 64 + 48);
  return b;
}
/** Small ZIP writer (deflate) so tests can build APK/AAB fixtures. */
export function zip(entries) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const [name, data] of entries) {
    const comp = zlib.deflateRawSync(data);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp);
    central.push(ch, n);
    off += lh.length + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Minimal app bundle with one arm64 native library aligned to `align`. */
export const aab = (align = 16384) => zip([
  ['base/manifest/AndroidManifest.xml', Buffer.from('m')], ['base/resources.pb', Buffer.from('r')],
  ['base/dex/classes.dex', Buffer.from('d')], ['base/lib/arm64-v8a/libnative.so', elf(align)],
]);

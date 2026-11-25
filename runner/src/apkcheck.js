// Sanity check for built APKs: a valid APK is a ZIP whose central directory lists
// AndroidManifest.xml and resources.arsc. Catches toolchain breakage (e.g. an aapt2 too old for the
// AGP version) that Gradle itself reports as success, before the APK reaches a phone.
import fs from 'node:fs';

/** Returns the entry names from a ZIP's central directory (no extraction). */
export function zipEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65_557); // EOCD (22 bytes) + max comment
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a ZIP file');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset + cdSize > size) throw new Error('corrupt ZIP central directory');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const names = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt ZIP central directory entry');
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      names.push(cd.toString('utf8', p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    fs.closeSync(fd);
  }
}

/** Returns null if the APK looks installable, otherwise a human-readable problem. */
export function apkProblem(file) {
  let names;
  try {
    names = new Set(zipEntries(file));
  } catch (e) {
    return `APK is not a valid ZIP (${e.message})`;
  }
  const missing = ['AndroidManifest.xml', 'resources.arsc'].filter((n) => !names.has(n));
  if (!missing.length) return null;
  return `APK is missing ${missing.join(' and ')}; the resource toolchain produced a broken package. `
    + 'This usually means aapt2 is too old for this AGP version: use AAPT2_MODE=box64 (see Environment / RUNBOOK §7).';
}

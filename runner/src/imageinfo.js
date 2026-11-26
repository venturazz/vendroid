// Image type + dimensions from file headers (PNG, JPEG, WebP, GIF, SVG). No decoding, no dependencies.
export const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };

export function imageInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // PNG: signature + IHDR width/height (big endian)
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.length >= 24) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf.toString('ascii', 0, 4) === 'GIF8') return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  // WebP (RIFF....WEBP)
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP' && buf.length >= 30) {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X') return { type: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { type: 'webp', width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    if (fmt === 'VP8 ') return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    return { type: 'webp', width: null, height: null };
  }
  // JPEG: walk segments to the first SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
        return { type: 'jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
    return { type: 'jpeg', width: null, height: null };
  }
  const head = buf.subarray(0, 512).toString('utf8');
  if (/<svg[\s>]/i.test(head)) return { type: 'svg', width: null, height: null };
  return null;
}

/** Content type for downloads/previews by extension. */
export function mimeFor(p) {
  const ext = p.toLowerCase().split('.').pop();
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
    ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', json: 'application/json', pdf: 'application/pdf',
  }[ext] || 'application/octet-stream';
}

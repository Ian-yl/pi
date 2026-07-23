import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function saveBuffer(root, folder, bytes, preferredName = 'image.png') {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const ext = extension(bytes, preferredName);
  const relative = `${folder}/${hash.slice(0, 24)}${ext}`;
  const disk = path.join(root, relative);
  mkdirSync(path.dirname(disk), { recursive: true });
  writeFileSync(disk, bytes);
  return { url: `/media/${relative}`, sha256: hash, bytes: bytes.length };
}
export function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function extension(bytes, name) {
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === 'PNG') return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return '.webp';
  return path.extname(name) || '.bin';
}

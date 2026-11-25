import { config } from '../config.js';
import { bad, isPackage, isSerial } from '../validate.js';

export const str = (v, max, name) => {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > max) throw bad(`${name} must be a string up to ${max} chars`);
  return v;
};
export const serialOf = (v) => {
  const s = v || config.defaultDevice;
  if (!isSerial(s)) throw bad('A valid device serial or <ip>:<port> is required');
  return s;
};
export const pkgOf = (v, fallback) => {
  const p = v || fallback || config.defaultPackage;
  if (!isPackage(p)) throw bad('A valid package name is required');
  return p;
};

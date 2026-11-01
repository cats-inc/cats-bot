/** Policy-free release primitives. Product adapters retain signing, repositories, formats and publication authority. */
import { createHash } from 'node:crypto';
export const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
export function stableReleaseVersion(tag, { trim = false, allowLeadingZeros = false } = {}) {
  const value = typeof tag === 'string' ? (trim ? tag.trim() : tag) : '';
  const pattern = allowLeadingZeros ? /^v\d+\.\d+\.\d+$/u : /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
  if (!pattern.test(value) || !value.slice(1).split('.').map(Number).every(Number.isSafeInteger)) throw new Error('Use an exact vX.Y.Z release tag.');
  return value.slice(1);
}

/**
 * SPEC-003 FR-3: the only place a page may send the owner is an http(s) URL,
 * opened in the system browser. Electron-free so it is tested directly.
 */
export function externalUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
}

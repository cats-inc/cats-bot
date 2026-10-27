/**
 * SPEC-003 FR-3: what a link or an image in a bot reply may do. The rules
 * follow cats-platform `MessageBodyMarkdown.tsx` (MIT, same author): only
 * http(s) leaves the note, for the system browser (the shell's window-open
 * handler); local files, anchors and other schemes stay inert so a click
 * never navigates the note; remote images are not loaded on render, so a
 * reply cannot make requests just by being shown.
 */

const EXTERNAL = /^https?:\/\//iu;

export type LinkTarget = { kind: 'external'; href: string } | { kind: 'inert'; title: string };

export function linkTarget(href: string | undefined): LinkTarget {
  if (href && EXTERNAL.test(href)) return { kind: 'external', href };
  return { kind: 'inert', title: href ?? '' };
}

export type ImageTarget = { kind: 'external'; href: string; label: string } | { kind: 'inert'; label: string };

export function imageTarget(src: string | undefined, alt: string | undefined): ImageTarget {
  const label = alt || src || '';
  if (src && EXTERNAL.test(src)) return { kind: 'external', href: src, label };
  return { kind: 'inert', label };
}

/**
 * SPEC-003 FR-8 to FR-10: the glyphs of the composer's buttons, drawn on a 16 px grid with a 1.5 stroke like
 * Cats Desktop's composer. Attach is a paperclip and the screenshot is a dragged-out region with a pointer,
 * the conventions chat apps use; the screenshot is not a camera, since nothing is photographed. Send is Cats
 * Desktop's up arrow, and a paper plane in the direct message. The same paths are in Cats Desktop's
 * `composerMenuIcons.tsx` and `composerSendIcon.tsx`.
 */

export type ComposerGlyphKind = 'attach' | 'screenshot' | 'voice' | 'send' | 'sendDirect';

const PATHS: Record<ComposerGlyphKind, readonly string[]> = {
  attach: ['M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l5.5-5.5a2.5 2.5 0 0 1 3.5 3.5l-5.5 5.5a1.2 1.2 0 0 1-1.7-1.7L10 4.5'],
  screenshot: [
    'M2 5V3a1 1 0 0 1 1-1h2M11 2h2a1 1 0 0 1 1 1v1.5M5 14H3a1 1 0 0 1-1-1v-2M7.25 2h1.5M2 7.25v1.5M7.25 14H8.5',
    'M9.5 9.5l5 1.8-2.1.8-.8 2.1z',
  ],
  voice: ['M6 4a2 2 0 0 1 4 0v4a2 2 0 0 1-4 0z', 'M3 8a5 5 0 0 0 10 0', 'M8 13v2', 'M6 15h4'],
  send: ['M8 13V3', 'M3 7l5-5 5 5'],
  sendDirect: ['M14.5 1.5 1.5 6.5l5.5 2.5 2.5 5.5z', 'M14.5 1.5 7 9'],
};

/** A composer glyph; `struck` crosses it out for a notice about that button (ADR-024). */
export function ComposerGlyph({ kind, size = 16, struck = false }: { kind: ComposerGlyphKind; size?: number; struck?: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {PATHS[kind].map((d) => <path key={d} d={d} />)}
    {/* Top left to bottom right, across the paperclip's own diagonal rather than along it. */}
    {struck && <path d="M2 2l12 12" />}
  </svg>;
}

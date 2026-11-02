import { DEFAULT_BOT_AVATAR, isBotAvatar, type BotAvatar } from '../shared/avatars.ts';

/**
 * SPEC-008 FR-29: every look's drawing, from one source. The floating Cat puts
 * the markup in its page, so floating.css can animate `.body`, `.eyes-open` and
 * `.eyes-closed`; the settings and note pages show it as an image, where no
 * style reaches it, so the closed eyes are hidden by attribute. CSS still wins
 * over that attribute in the floating Cat. Pages forbid inline styles
 * (floating.html's CSP), so drawings use presentation attributes only, and all
 * of them fill the same 128 box the floating Cat's hit area assumes.
 *
 * The first look is `cat.svg`, which the app icons are rendered from.
 */

function cat(parts: { defs?: string; face: string; eyesOpen: string; closedStroke: string; eyesClosed: string; front: string }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${parts.defs ? `<defs>${parts.defs}</defs>` : ''}`
    + `<g class="body">${parts.face}`
    + `<g class="eyes-open">${parts.eyesOpen}</g>`
    + `<g class="eyes-closed" display="none" stroke="${parts.closedStroke}" stroke-width="3.5" fill="none" stroke-linecap="round">${parts.eyesClosed}</g>`
    + `${parts.front}</g></svg>`;
}

const ART: Readonly<Record<BotAvatar, string>> = {
  // Orange tabby, the original: wide oval face, pointed ears, forehead stripes.
  ginger: cat({
    face: '<path d="M22 54 L26 14 Q28 8 34 12 L58 32 Z" fill="#c9771f"/>'
      + '<path d="M106 54 L102 14 Q100 8 94 12 L70 32 Z" fill="#c9771f"/>'
      + '<path d="M30 44 L32 22 L50 36 Z" fill="#f6c9a8"/>'
      + '<path d="M98 44 L96 22 L78 36 Z" fill="#f6c9a8"/>'
      + '<ellipse cx="64" cy="72" rx="48" ry="42" fill="#e3933a"/>'
      + '<path d="M64 30 Q58 44 64 52 Q70 44 64 30 Z" fill="#c9771f"/>'
      + '<path d="M40 38 Q44 48 40 56" stroke="#c9771f" stroke-width="5" fill="none" stroke-linecap="round"/>'
      + '<path d="M88 38 Q84 48 88 56" stroke="#c9771f" stroke-width="5" fill="none" stroke-linecap="round"/>'
      + '<ellipse cx="64" cy="90" rx="26" ry="18" fill="#fbe3c9"/>',
    eyesOpen: '<ellipse cx="44" cy="70" rx="9" ry="11" fill="#2b2a26"/>'
      + '<ellipse cx="84" cy="70" rx="9" ry="11" fill="#2b2a26"/>'
      + '<circle cx="47" cy="66" r="3.2" fill="#fff"/>'
      + '<circle cx="87" cy="66" r="3.2" fill="#fff"/>',
    closedStroke: '#2b2a26',
    eyesClosed: '<path d="M35 71 Q44 77 53 71"/><path d="M75 71 Q84 77 93 71"/>',
    front: '<path d="M58 82 L70 82 L64 89 Z" fill="#e0707a"/>'
      + '<path d="M64 89 Q60 96 54 94 M64 89 Q68 96 74 94" stroke="#2b2a26" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
      + '<path d="M20 82 L40 85 M18 92 L40 90 M108 82 L88 85 M110 92 L88 90" stroke="#7b5a3a" stroke-width="2" stroke-linecap="round"/>'
      + '<ellipse cx="34" cy="86" rx="7" ry="4" fill="#f2a7a0" opacity="0.6"/>'
      + '<ellipse cx="94" cy="86" rx="7" ry="4" fill="#f2a7a0" opacity="0.6"/>',
  }),
  // Black and white: broad, flat face, short ears, a white blaze and bib, green eyes, a bow tie.
  tuxedo: cat({
    face: '<path d="M18 62 L22 30 Q24 23 31 27 L56 42 Z" fill="#2f3139"/>'
      + '<path d="M110 62 L106 30 Q104 23 97 27 L72 42 Z" fill="#2f3139"/>'
      + '<path d="M28 52 L30 36 L45 45 Z" fill="#e9a3a8"/>'
      + '<path d="M100 52 L98 36 L83 45 Z" fill="#e9a3a8"/>'
      + '<ellipse cx="64" cy="76" rx="52" ry="37" fill="#3a3d47" stroke="#555966" stroke-width="1.5"/>'
      + '<path d="M64 42 C60 56 58 66 53 78 L75 78 C70 66 68 56 64 42 Z" fill="#f7f5ef"/>'
      + '<ellipse cx="64" cy="92" rx="30" ry="19" fill="#f7f5ef"/>'
      + '<path d="M64 119 L50 111 L50 127 Z" fill="#c8443c"/>'
      + '<path d="M64 119 L78 111 L78 127 Z" fill="#c8443c"/>'
      + '<circle cx="64" cy="119" r="3.6" fill="#9f2f29"/>',
    eyesOpen: '<ellipse cx="42" cy="71" rx="11" ry="11" fill="#a9de6b"/>'
      + '<ellipse cx="86" cy="71" rx="11" ry="11" fill="#a9de6b"/>'
      + '<ellipse cx="42" cy="71" rx="4.6" ry="9.5" fill="#1e1f24"/>'
      + '<ellipse cx="86" cy="71" rx="4.6" ry="9.5" fill="#1e1f24"/>'
      + '<circle cx="44.5" cy="66.5" r="2.6" fill="#fff"/>'
      + '<circle cx="88.5" cy="66.5" r="2.6" fill="#fff"/>',
    closedStroke: '#f3f1ea',
    eyesClosed: '<path d="M31 71 Q42 78 52 71"/><path d="M76 71 Q86 78 97 71"/>',
    front: '<path d="M58 84 L70 84 L64 91 Z" fill="#e0707a"/>'
      + '<path d="M64 91 Q60 98 54 96 M64 91 Q68 98 74 96" stroke="#3a3d47" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
      + '<path d="M14 84 L38 88 M12 96 L38 94 M114 84 L90 88 M116 96 L90 94" stroke="#a6a6ae" stroke-width="2" stroke-linecap="round"/>',
  }),
  // Seal point: narrow face tapering to the chin, tall ears, a dark mask, blue almond eyes.
  siamese: cat({
    defs: '<clipPath id="siamese-head"><path d="M64 32 C88 32 106 46 106 66 C106 88 84 116 64 116 C44 116 22 88 22 66 C22 46 40 32 64 32 Z"/></clipPath>'
      + '<radialGradient id="siamese-mask"><stop offset="0" stop-color="#4b372c"/><stop offset="0.62" stop-color="#5a4336"/><stop offset="1" stop-color="#5a4336" stop-opacity="0"/></radialGradient>',
    face: '<path d="M26 58 L17 8 Q17 2 23 6 L58 34 Z" fill="#4b372c"/>'
      + '<path d="M102 58 L111 8 Q111 2 105 6 L70 34 Z" fill="#4b372c"/>'
      + '<path d="M31 46 L25 17 L48 35 Z" fill="#c98d7f"/>'
      + '<path d="M97 46 L103 17 L80 35 Z" fill="#c98d7f"/>'
      + '<path d="M64 32 C88 32 106 46 106 66 C106 88 84 116 64 116 C44 116 22 88 22 66 C22 46 40 32 64 32 Z" fill="#f2e4cd"/>'
      + '<g clip-path="url(#siamese-head)"><ellipse cx="64" cy="84" rx="44" ry="42" fill="url(#siamese-mask)"/></g>',
    eyesOpen: '<path d="M29 61 Q44 56 55 73 Q37 77 29 61 Z" fill="#6ab7f0"/>'
      + '<path d="M99 61 Q84 56 73 73 Q91 77 99 61 Z" fill="#6ab7f0"/>'
      + '<ellipse cx="43" cy="67" rx="3.4" ry="6.6" fill="#16202b"/>'
      + '<ellipse cx="85" cy="67" rx="3.4" ry="6.6" fill="#16202b"/>'
      + '<circle cx="45" cy="64" r="1.8" fill="#fff"/>'
      + '<circle cx="87" cy="64" r="1.8" fill="#fff"/>',
    closedStroke: '#efe2cb',
    eyesClosed: '<path d="M34 67 Q44 75 55 71"/><path d="M94 67 Q84 75 73 71"/>',
    front: '<path d="M59 88 L69 88 L64 94 Z" fill="#241a15"/>'
      + '<path d="M64 94 Q61 101 56 99 M64 94 Q67 101 72 99" stroke="#d8c6ae" stroke-width="2.2" fill="none" stroke-linecap="round"/>'
      + '<path d="M18 86 L42 90 M20 98 L44 96 M110 86 L86 90 M108 98 L84 96" stroke="#efe2cb" stroke-width="1.8" stroke-linecap="round"/>',
  }),
  // White with orange and black patches: tall oval face, one ear of each colour, odd eyes.
  calico: cat({
    defs: '<clipPath id="calico-head"><ellipse cx="64" cy="70" rx="44" ry="45"/></clipPath>',
    face: '<path d="M25 50 L23 18 Q24 10 31 14 L56 30 Z" fill="#e8963f"/>'
      + '<path d="M103 50 L105 18 Q104 10 97 14 L72 30 Z" fill="#37322f"/>'
      + '<path d="M32 40 L31 23 L47 33 Z" fill="#f6c9a8"/>'
      + '<path d="M96 40 L97 23 L81 33 Z" fill="#b98d8a"/>'
      + '<ellipse cx="64" cy="70" rx="44" ry="45" fill="#fbf6ec" stroke="#e6dcc8" stroke-width="1.5"/>'
      + '<g clip-path="url(#calico-head)">'
      + '<path d="M10 16 H56 C62 34 62 56 52 74 C44 88 24 90 10 84 Z" fill="#e8963f"/>'
      + '<path d="M72 16 H118 V58 C104 62 92 56 84 46 C78 38 73 28 72 16 Z" fill="#37322f"/>'
      + '<ellipse cx="94" cy="96" rx="11" ry="8" fill="#e8963f"/>'
      + '<ellipse cx="40" cy="104" rx="8" ry="6" fill="#37322f"/>'
      + '</g>',
    eyesOpen: '<circle cx="44" cy="68" r="10.5" fill="#7cc4ee"/>'
      + '<circle cx="84" cy="68" r="10.5" fill="#dfa93f"/>'
      + '<circle cx="44" cy="68" r="6.6" fill="#22201d"/>'
      + '<circle cx="84" cy="68" r="6.6" fill="#22201d"/>'
      + '<circle cx="47" cy="64.5" r="2.8" fill="#fff"/>'
      + '<circle cx="87" cy="64.5" r="2.8" fill="#fff"/>',
    closedStroke: '#2b2a26',
    eyesClosed: '<path d="M34 69 Q44 76 54 69"/><path d="M74 69 Q84 76 94 69"/>',
    front: '<path d="M59 82 L69 82 L64 88 Z" fill="#e0707a"/>'
      + '<path d="M64 88 Q60 95 54 93 M64 88 Q68 95 74 93" stroke="#2b2a26" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
      + '<path d="M22 82 L42 85 M20 92 L42 90 M106 82 L86 85 M108 92 L86 90" stroke="#8f8a80" stroke-width="2" stroke-linecap="round"/>'
      + '<ellipse cx="33" cy="84" rx="6.5" ry="3.6" fill="#f2a7a0" opacity="0.65"/>'
      + '<ellipse cx="95" cy="84" rx="6.5" ry="3.6" fill="#f2a7a0" opacity="0.65"/>',
  }),
  // Blue-gray: round chubby face, small ears folded forward, soft forehead stripes, big copper eyes.
  fold: cat({
    face: '<ellipse cx="64" cy="72" rx="51" ry="46" fill="#93a0b3"/>'
      + '<path d="M22 50 C17 32 30 19 46 25 C53 29 54 36 50 41 C41 38 30 42 22 50 Z" fill="#6d7a8e"/>'
      + '<path d="M106 50 C111 32 98 19 82 25 C75 29 74 36 78 41 C87 38 98 42 106 50 Z" fill="#6d7a8e"/>'
      + '<path d="M52 33 Q55 41 53 49" stroke="#6d7a8e" stroke-width="4.5" fill="none" stroke-linecap="round"/>'
      + '<path d="M64 29 Q64 39 64 49" stroke="#6d7a8e" stroke-width="4.5" fill="none" stroke-linecap="round"/>'
      + '<path d="M76 33 Q73 41 75 49" stroke="#6d7a8e" stroke-width="4.5" fill="none" stroke-linecap="round"/>'
      + '<ellipse cx="64" cy="93" rx="25" ry="17" fill="#dbe1ea"/>',
    eyesOpen: '<circle cx="42" cy="70" r="13" fill="#f0a63c"/>'
      + '<circle cx="86" cy="70" r="13" fill="#f0a63c"/>'
      + '<circle cx="42" cy="70" r="8.4" fill="#232730"/>'
      + '<circle cx="86" cy="70" r="8.4" fill="#232730"/>'
      + '<circle cx="46" cy="65.5" r="3.4" fill="#fff"/>'
      + '<circle cx="90" cy="65.5" r="3.4" fill="#fff"/>',
    closedStroke: '#2f3540',
    eyesClosed: '<path d="M30 71 Q42 79 54 71"/><path d="M74 71 Q86 79 98 71"/>',
    front: '<path d="M59 85 L69 85 L64 91 Z" fill="#c8737e"/>'
      + '<path d="M64 91 Q60 98 54 96 M64 91 Q68 98 74 96" stroke="#3b4250" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
      + '<path d="M14 86 L38 89 M13 97 L38 95 M114 86 L90 89 M115 97 L90 95" stroke="#4f5a6b" stroke-width="2" stroke-linecap="round"/>'
      + '<ellipse cx="30" cy="90" rx="7" ry="4" fill="#e7a3ad" opacity="0.6"/>'
      + '<ellipse cx="98" cy="90" rx="7" ry="4" fill="#e7a3ad" opacity="0.6"/>',
  }),
};

/** The look's SVG markup; anything else, such as a value from an older core, draws the default Cat. */
export function avatarSvg(avatar: unknown): string {
  return ART[isBotAvatar(avatar) ? avatar : DEFAULT_BOT_AVATAR];
}

/** The same drawing as an `<img>` source (the pages' CSP allows `data:` images). */
export function avatarUrl(avatar: unknown): string {
  return `data:image/svg+xml,${encodeURIComponent(avatarSvg(avatar))}`;
}

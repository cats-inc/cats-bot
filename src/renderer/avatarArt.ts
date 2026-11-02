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

/** One spot of the Bengal's coat: a dark ring around a lighter middle. */
function rosette(cx: number, cy: number, rx: number, ry: number, rotate: number): string {
  const turn = ` transform="rotate(${rotate} ${cx} ${cy})"`;
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#5b3a1c"${turn}/>`
    + `<ellipse cx="${cx}" cy="${cy}" rx="${rx * 0.48}" ry="${ry * 0.48}" fill="#b98438"${turn}/>`;
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
  // The everyday brown tabby: taupe coat, a bold M on the forehead, cheek stripes, yellow-green eyes.
  tabby: cat({
    face: '<path d="M24 54 L27 16 Q29 10 35 14 L58 33 Z" fill="#7d6245"/>'
      + '<path d="M104 54 L101 16 Q99 10 93 14 L70 33 Z" fill="#7d6245"/>'
      + '<path d="M31 45 L33 24 L50 36 Z" fill="#e8bfa6"/>'
      + '<path d="M97 45 L95 24 L78 36 Z" fill="#e8bfa6"/>'
      + '<ellipse cx="64" cy="73" rx="47" ry="41" fill="#a98d68"/>'
      + '<path d="M43 52 L51 39 L64 51 L77 39 L85 52" stroke="#46351f" stroke-width="4.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M64 33 L64 44 M52 34 Q54 38 54 41 M76 34 Q74 38 74 41" stroke="#46351f" stroke-width="4" fill="none" stroke-linecap="round"/>'
      + '<path d="M19 68 Q26 69 31 66 M19 82 Q26 82 32 79 M109 68 Q102 69 97 66 M109 82 Q102 82 96 79" stroke="#46351f" stroke-width="4" fill="none" stroke-linecap="round"/>'
      + '<ellipse cx="64" cy="92" rx="24" ry="17" fill="#efe3cf"/>',
    eyesOpen: '<circle cx="44" cy="70" r="10.5" fill="#bccb5e" stroke="#3a2b1c" stroke-width="1.8"/>'
      + '<circle cx="84" cy="70" r="10.5" fill="#bccb5e" stroke="#3a2b1c" stroke-width="1.8"/>'
      + '<ellipse cx="44" cy="70" rx="4.8" ry="8.6" fill="#1f1c17"/>'
      + '<ellipse cx="84" cy="70" rx="4.8" ry="8.6" fill="#1f1c17"/>'
      + '<circle cx="46.5" cy="66" r="2.6" fill="#fff"/>'
      + '<circle cx="86.5" cy="66" r="2.6" fill="#fff"/>',
    closedStroke: '#2c2115',
    eyesClosed: '<path d="M34 71 Q44 78 54 71"/><path d="M74 71 Q84 78 94 71"/>',
    front: '<path d="M59 84 L69 84 L64 90 Z" fill="#c4665b"/>'
      + '<path d="M64 90 Q60 97 54 95 M64 90 Q68 97 74 95" stroke="#2c2115" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
      + '<path d="M18 92 L42 92 M21 102 L44 98 M110 92 L86 92 M107 102 L84 98" stroke="#3f3120" stroke-width="1.9" stroke-linecap="round"/>',
  }),
  // White with a tabby cap: gray-brown striped patches over the ears and eyes, a white blaze, amber eyes.
  'white-tabby': cat({
    defs: '<clipPath id="white-tabby-head"><ellipse cx="64" cy="72" rx="46" ry="43"/></clipPath>',
    face: '<path d="M24 52 L26 16 Q27 9 34 13 L57 31 Z" fill="#7f7365"/>'
      + '<path d="M104 52 L102 16 Q101 9 94 13 L71 31 Z" fill="#7f7365"/>'
      + '<path d="M31 43 L32 23 L49 34 Z" fill="#f0c4b0"/>'
      + '<path d="M97 43 L96 23 L79 34 Z" fill="#f0c4b0"/>'
      + '<ellipse cx="64" cy="72" rx="46" ry="43" fill="#fbf8f1" stroke="#e6dfd2" stroke-width="1.5"/>'
      + '<g clip-path="url(#white-tabby-head)">'
      + '<path d="M8 18 H60 C60 40 57 54 53 62 C46 74 26 78 8 70 Z" fill="#a3978a"/>'
      + '<path d="M120 18 H68 C68 40 71 54 75 62 C82 74 102 78 120 70 Z" fill="#a3978a"/>'
      + '<path d="M28 34 Q34 44 32 53 M43 28 Q47 38 45 48 M17 58 Q24 61 30 60 M100 34 Q94 44 96 53 M85 28 Q81 38 83 48 M111 58 Q104 61 98 60" stroke="#51453a" stroke-width="4" fill="none" stroke-linecap="round"/>'
      + '</g>',
    eyesOpen: '<circle cx="44" cy="71" r="10.5" fill="#e4b64d" stroke="#3e352b" stroke-width="1.6"/>'
      + '<circle cx="84" cy="71" r="10.5" fill="#e4b64d" stroke="#3e352b" stroke-width="1.6"/>'
      + '<circle cx="44" cy="71" r="6.6" fill="#231f1a"/>'
      + '<circle cx="84" cy="71" r="6.6" fill="#231f1a"/>'
      + '<circle cx="47" cy="67.5" r="2.8" fill="#fff"/>'
      + '<circle cx="87" cy="67.5" r="2.8" fill="#fff"/>',
    closedStroke: '#332b22',
    eyesClosed: '<path d="M34 72 Q44 79 54 72"/><path d="M74 72 Q84 79 94 72"/>',
    front: '<path d="M59 85 L69 85 L64 91 Z" fill="#e0707a"/>'
      + '<path d="M64 91 Q60 98 54 96 M64 91 Q68 98 74 96" stroke="#3e352b" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
      + '<path d="M22 88 L42 90 M22 98 L42 96 M106 88 L86 90 M106 98 L86 96" stroke="#8b8072" stroke-width="2" stroke-linecap="round"/>'
      + '<ellipse cx="32" cy="88" rx="6.5" ry="3.6" fill="#f2a7a0" opacity="0.65"/>'
      + '<ellipse cx="96" cy="88" rx="6.5" ry="3.6" fill="#f2a7a0" opacity="0.65"/>',
  }),
  // All black: tall ears and a sleek face with a rim that holds against a dark desktop, large golden eyes.
  black: cat({
    face: '<path d="M22 56 L20 12 Q21 6 27 10 L58 33 Z" fill="#2b2b32" stroke="#4a4a55" stroke-width="1.5" stroke-linejoin="round"/>'
      + '<path d="M106 56 L108 12 Q107 6 101 10 L70 33 Z" fill="#2b2b32" stroke="#4a4a55" stroke-width="1.5" stroke-linejoin="round"/>'
      + '<path d="M29 46 L27 21 L48 35 Z" fill="#54434f"/>'
      + '<path d="M99 46 L101 21 L80 35 Z" fill="#54434f"/>'
      + '<ellipse cx="64" cy="73" rx="45" ry="41" fill="#2b2b32" stroke="#4a4a55" stroke-width="1.5"/>',
    eyesOpen: '<circle cx="43" cy="70" r="12.5" fill="#f4c542"/>'
      + '<circle cx="85" cy="70" r="12.5" fill="#f4c542"/>'
      + '<ellipse cx="43" cy="70" rx="4.2" ry="10.6" fill="#15151a"/>'
      + '<ellipse cx="85" cy="70" rx="4.2" ry="10.6" fill="#15151a"/>'
      + '<circle cx="46" cy="65.5" r="2.8" fill="#fff"/>'
      + '<circle cx="88" cy="65.5" r="2.8" fill="#fff"/>',
    closedStroke: '#f4c542',
    eyesClosed: '<path d="M32 71 Q43 79 54 71"/><path d="M74 71 Q85 79 96 71"/>',
    front: '<path d="M59 87 L69 87 L64 93 Z" fill="#a0727e"/>'
      + '<path d="M64 93 Q60 100 54 98 M64 93 Q68 100 74 98" stroke="#9a9aa8" stroke-width="2.2" fill="none" stroke-linecap="round"/>'
      + '<path d="M18 86 L40 90 M17 97 L40 96 M110 86 L88 90 M111 97 L88 96" stroke="#c4c4d0" stroke-width="1.9" stroke-linecap="round"/>',
  }),
  // Persian: a fluffy silver-white outline, small ears, a flat face with wide-set emerald eyes.
  persian: cat({
    face: '<path d="M24 50 L27 19 Q29 13 35 17 L54 36 Z" fill="#c9cdd7"/>'
      + '<path d="M104 50 L101 19 Q99 13 93 17 L74 36 Z" fill="#c9cdd7"/>'
      + '<path d="M30 40 L32 24 L46 35 Z" fill="#ebbcc4"/>'
      + '<path d="M98 40 L96 24 L82 35 Z" fill="#ebbcc4"/>'
      + '<path d="M54.8 31.7 Q64 22.2 73.2 31.7 Q85.8 25.4 90.5 36.9 Q104.9 34.6 104.6 46.7 Q119.1 48.6 113.8 60 Q126.6 65.8 117 75 Q126.6 84.2 113.8 90 Q119.1 101.4 104.6 103.3 Q104.9 115.4 90.5 113.1 Q85.8 124.6 73.2 118.3 Q64 127.8 54.8 118.3 Q42.2 124.6 37.5 113.1 Q23.1 115.4 23.4 103.3 Q8.9 101.4 14.2 90 Q1.4 84.2 11 75 Q1.4 65.8 14.2 60 Q8.9 48.6 23.4 46.7 Q23.1 34.6 37.5 36.9 Q42.2 25.4 54.8 31.7 Z" fill="#d4d8e1"/>'
      + '<path d="M55.8 36.6 Q64 32.1 72.2 36.6 Q81.7 34.7 87.5 41.2 Q97.2 42.1 100 49.9 Q108.8 53.6 108.2 61.7 Q114.9 67.6 111 75 Q114.9 82.4 108.2 88.3 Q108.8 96.4 100 100.1 Q97.2 107.9 87.5 108.8 Q81.7 115.3 72.2 113.4 Q64 117.9 55.8 113.4 Q46.3 115.3 40.5 108.8 Q30.8 107.9 28 100.1 Q19.2 96.5 19.8 88.3 Q13.1 82.4 17 75 Q13.1 67.6 19.8 61.7 Q19.2 53.6 28 49.9 Q30.8 42.1 40.5 41.2 Q46.3 34.7 55.8 36.6 Z" fill="#f8f7f3"/>',
    eyesOpen: '<circle cx="41" cy="72" r="12" fill="#4fb6a3" stroke="#39404c" stroke-width="2.2"/>'
      + '<circle cx="87" cy="72" r="12" fill="#4fb6a3" stroke="#39404c" stroke-width="2.2"/>'
      + '<circle cx="41" cy="72" r="7.6" fill="#1d2228"/>'
      + '<circle cx="87" cy="72" r="7.6" fill="#1d2228"/>'
      + '<circle cx="44.5" cy="68" r="3.2" fill="#fff"/>'
      + '<circle cx="90.5" cy="68" r="3.2" fill="#fff"/>',
    closedStroke: '#39404c',
    eyesClosed: '<path d="M30 73 Q41 81 52 73"/><path d="M76 73 Q87 81 98 73"/>',
    front: '<path d="M60 80 L68 80 L64 85 Z" fill="#e58a96"/>'
      + '<path d="M64 85 Q61 90 57 89 M64 85 Q67 90 71 89" stroke="#6f7380" stroke-width="2.2" fill="none" stroke-linecap="round"/>'
      + '<path d="M26 90 L46 88 M28 99 L47 94 M102 90 L82 88 M100 99 L81 94" stroke="#a9adb9" stroke-width="1.8" stroke-linecap="round"/>'
      + '<ellipse cx="33" cy="87" rx="6" ry="3.4" fill="#f4b6bd" opacity="0.7"/>'
      + '<ellipse cx="95" cy="87" rx="6" ry="3.4" fill="#f4b6bd" opacity="0.7"/>',
  }),
  // Bengal: golden coat with rosettes, rounded ears, pale spectacles and a white whisker pad, green eyes.
  bengal: cat({
    defs: '<clipPath id="bengal-head"><path d="M64 30 C90 30 110 46 110 70 C110 94 88 114 64 114 C40 114 18 94 18 70 C18 46 38 30 64 30 Z"/></clipPath>',
    face: '<path d="M22 54 C20 36 22 20 32 16 C40 16 52 26 58 34 Z" fill="#a8742f"/>'
      + '<path d="M106 54 C108 36 106 20 96 16 C88 16 76 26 70 34 Z" fill="#a8742f"/>'
      + '<path d="M30 44 C29 34 31 25 35 24 C41 26 47 31 50 36 Z" fill="#f0cfa8"/>'
      + '<path d="M98 44 C99 34 97 25 93 24 C87 26 81 31 78 36 Z" fill="#f0cfa8"/>'
      + '<path d="M64 30 C90 30 110 46 110 70 C110 94 88 114 64 114 C40 114 18 94 18 70 C18 46 38 30 64 30 Z" fill="#dcaa5e"/>'
      + '<g clip-path="url(#bengal-head)">'
      + '<ellipse cx="44" cy="71" rx="16" ry="15" fill="#f6e6c6"/>'
      + '<ellipse cx="84" cy="71" rx="16" ry="15" fill="#f6e6c6"/>'
      + rosette(26, 56, 6, 5, -20) + rosette(102, 56, 6, 5, 20)
      + rosette(24, 84, 6.5, 5.5, 10) + rosette(104, 84, 6.5, 5.5, -10)
      + rosette(36, 42, 5.5, 4.5, -25) + rosette(92, 42, 5.5, 4.5, 25)
      + rosette(38, 102, 5.5, 4.5, 20) + rosette(90, 102, 5.5, 4.5, -20)
      + '<path d="M50 49 L56 39 L64 48 L72 39 L78 49 M64 32 L64 40" stroke="#5b3a1c" stroke-width="3.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</g>'
      + '<ellipse cx="64" cy="93" rx="25" ry="17" fill="#fbf1df"/>',
    eyesOpen: '<circle cx="44" cy="71" r="10" fill="#b5cf4d" stroke="#3b2613" stroke-width="2"/>'
      + '<circle cx="84" cy="71" r="10" fill="#b5cf4d" stroke="#3b2613" stroke-width="2"/>'
      + '<ellipse cx="44" cy="71" rx="4.4" ry="8.2" fill="#1b1610"/>'
      + '<ellipse cx="84" cy="71" rx="4.4" ry="8.2" fill="#1b1610"/>'
      + '<circle cx="46.4" cy="67.4" r="2.4" fill="#fff"/>'
      + '<circle cx="86.4" cy="67.4" r="2.4" fill="#fff"/>',
    closedStroke: '#3b2613',
    eyesClosed: '<path d="M34 72 Q44 79 54 72"/><path d="M74 72 Q84 79 94 72"/>',
    front: '<path d="M59 85 L69 85 L64 91 Z" fill="#b9604f"/>'
      + '<path d="M64 91 Q60 98 54 96 M64 91 Q68 98 74 96" stroke="#3b2613" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
      + '<path d="M18 92 L42 93 M21 102 L44 99 M110 92 L86 93 M107 102 L84 99" stroke="#6b4a27" stroke-width="1.9" stroke-linecap="round"/>',
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

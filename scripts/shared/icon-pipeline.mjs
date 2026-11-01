/** Render one SVG into PNG variants. Hosts supply Sharp or Electron; artwork and output paths stay product-owned. */
export async function renderIconVariants(svg, sizes, { render, resize } = {}) {
  const requested = [...new Set(sizes)];
  if (!requested.length || requested.some(size => !Number.isInteger(size) || size < 1 || size > 8192)) throw new Error('Icon sizes must be integers between 1 and 8192.');
  if (typeof render !== 'function') throw new Error('An icon renderer is required.');
  const results = new Map();
  const largest = Math.max(...requested);
  const master = resize ? await render(svg, largest) : null;
  for (const size of requested) {
    const png = resize ? (size === largest ? master : await resize(master, size)) : await render(svg, size);
    if (!(png instanceof Uint8Array) || png.length < 8 || !Buffer.from(png.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error(`Renderer returned invalid PNG for ${size}px.`);
    results.set(size, png);
  }
  return results;
}

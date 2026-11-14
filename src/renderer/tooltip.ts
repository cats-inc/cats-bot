/**
 * In-page tooltips, as Cats Desktop's `data-tooltip` portal draws them. A note opens without taking focus, and
 * macOS draws a native `title` tooltip only for the active app, so hovering a note's buttons showed nothing.
 * Every element with `data-tooltip` or `title` gets this tooltip instead: a `title` moves to `data-tooltip` the
 * first time the pointer reaches it, so a native tooltip never doubles this one. Keyboard focus shows it too.
 */

import { placeTooltip } from './tooltipPlacement.ts';

/** A pointer that only passes over a button shows nothing; once one tooltip shows, the next shows at once. */
const SHOW_DELAY_MS = 300;
const WARM_MS = 500;

/** The text an element's tooltip shows; a `title` is taken over so the native tooltip stays away. */
function tooltipText(element: HTMLElement): string {
  const title = element.getAttribute('title');
  if (title !== null) {
    element.removeAttribute('title');
    if (title) element.setAttribute('data-tooltip', title);
    else element.removeAttribute('data-tooltip');
  }
  return element.getAttribute('data-tooltip') ?? '';
}

function targetOf(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>('[data-tooltip], [title]') : null;
}

/** Starts the tooltips for this window; the returned function stops them. */
export function initTooltips(): () => void {
  const portal = document.createElement('div');
  portal.className = 'tooltipPortal';
  portal.setAttribute('role', 'tooltip');
  portal.setAttribute('aria-hidden', 'true');
  document.body.appendChild(portal);
  let current: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hiddenAt = 0;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const show = (target: HTMLElement) => {
    cancel();
    const text = tooltipText(target);
    if (!text || !target.isConnected) return hide();
    current = target;
    portal.textContent = text;
    // Measured at the corner, so the last place it showed (near an edge) does not squeeze the new text.
    portal.style.left = '0px';
    portal.style.top = '0px';
    portal.classList.add('tooltipVisible');
    const rect = target.getBoundingClientRect();
    const place = placeTooltip(rect, { width: portal.offsetWidth, height: portal.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight });
    portal.style.left = `${place.left}px`;
    portal.style.top = `${place.top}px`;
  };
  const hide = () => {
    cancel();
    if (current) hiddenAt = Date.now();
    current = null;
    portal.classList.remove('tooltipVisible');
  };
  const showSoon = (target: HTMLElement) => {
    if (target === current) return;
    cancel();
    tooltipText(target);
    if (current || Date.now() - hiddenAt < WARM_MS) show(target);
    else timer = setTimeout(() => show(target), SHOW_DELAY_MS);
  };

  const onOver = (event: MouseEvent) => {
    const target = targetOf(event.target);
    if (target) showSoon(target);
  };
  const onOut = (event: MouseEvent) => {
    const target = targetOf(event.target);
    if (target && !target.contains(event.relatedTarget as Node | null)) hide();
  };
  const onFocus = (event: FocusEvent) => {
    const target = targetOf(event.target);
    if (target && target.matches(':focus-visible')) show(target);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') hide();
  };
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', onOut, true);
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('focusout', hide, true);
  // A click acts on the button; its tooltip has said its piece. Scrolling moves the button away from it.
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', hide);
  return () => {
    hide();
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('mouseout', onOut, true);
    document.removeEventListener('focusin', onFocus, true);
    document.removeEventListener('focusout', hide, true);
    document.removeEventListener('mousedown', hide, true);
    document.removeEventListener('scroll', hide, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', hide);
    portal.remove();
  };
}

// The floating bot (SPEC-002 FR-7): a cat on the topmost layer that shows
// whether the bot is awake, thinking, asleep or has unread replies. The
// window ignores the mouse except over the cat and the bubble; dragging moves
// the window, a click opens the home note and a right click opens the tray menu.
import type { RuntimeState } from '../core/types.ts';
import { translate, type Locale } from '../shared/language.ts';

const api = window.catsBot;
const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`floating.html has no #${id}`);
  return element;
};
const body = document.body;
const cat = $('cat');
const badge = $('badge');
const bubble = $('bubble');
function reportInputRegions(): void {
  const regions = [...document.querySelectorAll<HTMLElement>('#cat, #bubble, .thinking-dots, .zzz')]
    .filter(element => element.getClientRects().length > 0)
    .map(element => {
      const r = element.getBoundingClientRect();
      return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 };
    });
  api.floating.setInputRegions(regions);
}
const regionObserver = new ResizeObserver(reportInputRegions);
for (const element of document.querySelectorAll<HTMLElement>('#cat, #bubble, .thinking-dots, .zzz')) regionObserver.observe(element);
let locale: Locale = 'en';
const changeLanguage = (next: { locale: Locale }) => {
  locale = next.locale;
  document.documentElement.lang = locale;
  $('bubble-close').setAttribute('aria-label', translate(locale, 'Dismiss'));
  render();
};
void api.language.get().then(changeLanguage);
api.language.onChange(changeLanguage);

const running = new Set<string>();
let runtimeState: RuntimeState = 'starting';
let homeId = 'home';
let homeSleeping = false;
let unread = 0;
let botName = 'Cats Bot';
let bubbleConversation: string | null = null;
let bubbleTimer: ReturnType<typeof setTimeout> | undefined;

function render(): void {
  body.classList.toggle('offline', runtimeState === 'failed' || runtimeState === 'stopped');
  body.classList.toggle('thinking', running.size > 0);
  body.classList.toggle('sleeping', running.size === 0 && homeSleeping);
  badge.hidden = unread === 0;
  badge.textContent = unread > 99 ? '99+' : String(unread);
  const state = running.size > 0 ? 'thinking' : homeSleeping ? 'asleep' : runtimeState === 'ready' ? 'awake' : `runtime ${runtimeState}`;
  cat.setAttribute(
    'aria-label',
    `${botName}: ${translate(locale, state)}${unread ? `, ${translate(locale, '{count} unread', { count: unread })}` : ''}`,
  );
  reportInputRegions();
}

async function refresh(): Promise<void> {
  const [status, conversations] = await Promise.all([api.invoke('status'), api.invoke('listConversations')]);
  botName = status.name;
  runtimeState = status.runtime.state;
  running.clear();
  if (status.queue.running) running.add(status.queue.running.id);
  unread = conversations.reduce((sum, record) => sum + record.unreadCount, 0);
  const home = conversations.find((record) => record.role === 'home');
  if (home) {
    homeId = home.id;
    homeSleeping = home.attachment.state === 'sleeping' || home.attachment.state === 'closed';
  }
  render();
}

api.onEvent((event) => {
  switch (event.type) {
    case 'work.updated':
      if (event.workItem.state === 'running') running.add(event.workItem.id);
      else running.delete(event.workItem.id);
      render();
      break;
    case 'turn.completed':
      running.delete(event.workItem.id);
      void refresh();
      break;
    case 'runtime.status':
      runtimeState = event.state;
      render();
      break;
    case 'presence.changed':
      if (event.conversationId === homeId) {
        homeSleeping = event.presence === 'sleeping';
        render();
      }
      break;
    case 'conversation.updated':
      void refresh();
      break;
    default:
      break;
  }
});

// Click-through everywhere but the cat and the bubble. Moves are forwarded
// while the window ignores the mouse, so every move decides by hit test.
// Not mouseleave: switching the window between ignoring and taking the mouse
// makes Chromium report a leave at once, which would switch it back.
let interactive = false;
let drag: { x: number; y: number; windowX: number; windowY: number; moved: boolean } | null = null;
function setInteractive(value: boolean): void {
  if (value === interactive) return;
  interactive = value;
  api.floating.setInteractive(value);
}
document.addEventListener('mousemove', (event) => {
  if (drag) return;
  const target = event.target instanceof Element ? event.target : null;
  setInteractive(Boolean(target && target.closest('#cat, #bubble')));
});

cat.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  cat.setPointerCapture(event.pointerId);
  drag = { x: event.screenX, y: event.screenY, windowX: window.screenX, windowY: window.screenY, moved: false };
});
cat.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const dx = event.screenX - drag.x;
  const dy = event.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  cat.classList.add('dragging');
  api.floating.moveTo(drag.windowX + dx, drag.windowY + dy);
});
const endDrag = (event: PointerEvent): void => {
  if (!drag) return;
  const wasClick = !drag.moved;
  drag = null;
  cat.classList.remove('dragging');
  if (cat.hasPointerCapture(event.pointerId)) cat.releasePointerCapture(event.pointerId);
  if (wasClick) void api.floating.activate();
  else api.floating.dragEnd();
  if (!cat.matches(':hover')) setInteractive(false);
};
cat.addEventListener('pointerup', endDrag);
cat.addEventListener('pointercancel', endDrag);
cat.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  void api.floating.menu();
});

function hideBubble(): void {
  bubble.hidden = true;
  bubbleConversation = null;
  clearTimeout(bubbleTimer);
  if (!cat.matches(':hover')) setInteractive(false);
  reportInputRegions();
}
bubble.addEventListener('click', () => {
  if (bubbleConversation) void api.window.openConversation(bubbleConversation);
  hideBubble();
});
$('bubble-close').addEventListener('click', (event) => {
  event.stopPropagation();
  hideBubble();
});
api.floating.onBubble((message) => {
  bubbleConversation = message.conversationId;
  $('bubble-from').textContent = message.from;
  $('bubble-text').textContent = message.text;
  bubble.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, 15000);
  reportInputRegions();
});

void refresh();
setInterval(() => {
  void refresh();
}, 60000);

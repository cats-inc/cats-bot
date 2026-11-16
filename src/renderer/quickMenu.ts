// ADR-026: the floating Cat's quick menu. The shell builds, translates and places
// the items; this page draws them, turning out from the cat's head, and reports
// which one was chosen. A click beside the items, Escape or focus leaving
// closes it.
import { translate } from '../shared/language.ts';
import type { QuickMenuView } from '../shared/quickMenu.ts';

const api = window.catsBot;
const menu = document.getElementById('menu')!;

/** Each item starts turned this far round the head, the far ones further, toward the cat's feet. */
const turnFor = (view: QuickMenuView, index: number) =>
  `${(view.side === 'left' ? -1 : 1) * (16 + 5 * (view.items.length - 1 - index))}deg`;

function draw(view: QuickMenuView): HTMLButtonElement[] {
  document.documentElement.lang = view.locale;
  menu.setAttribute('aria-label', view.title);
  return view.items.map((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `item ${item.kind}`;
    button.setAttribute('role', 'menuitem');
    button.style.left = `${item.x}px`;
    button.style.top = `${item.y}px`;
    button.style.width = `${view.item.width}px`;
    button.style.height = `${view.item.height}px`;
    button.style.setProperty('--head-x', `${view.head.x - item.x}px`);
    button.style.setProperty('--head-y', `${view.head.y - item.y}px`);
    button.style.setProperty('--turn', turnFor(view, index));
    button.style.setProperty('--delay', `${index * 35}ms`);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.label;
    button.title = item.label;
    button.append(label);
    if (item.unread > 0) {
      const unread = document.createElement('span');
      unread.className = 'unread';
      unread.textContent = item.unread > 99 ? '99+' : String(item.unread);
      unread.setAttribute('aria-label', translate(view.locale, '{count} unread', { count: item.unread }));
      button.append(unread);
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      api.quickMenu.choose(index);
    });
    menu.append(button);
    return button;
  });
}

async function start(): Promise<void> {
  const view = await api.quickMenu.state();
  if (!view) {
    api.quickMenu.close();
    return;
  }
  const buttons = draw(view);
  // The window is all menu: a click on its transparent rest is a click beside the items.
  document.addEventListener('click', () => api.quickMenu.close());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      api.quickMenu.close();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : buttons.length - 1) : (at + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  });
}

void start();

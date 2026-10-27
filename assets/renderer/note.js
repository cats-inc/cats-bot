// The sticky-note renderer (SPEC-001 FR-33). It holds no durable state: the
// transcript is reloaded from the core, streaming deltas are shown live, and
// everything else is a command through the preload bridge.
(() => {
  const api = window.catsBot;
  const conversationId = api.conversationId;
  const transcriptEl = document.getElementById('transcript');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const cancelEl = document.getElementById('cancel');
  const titleEl = document.getElementById('title');
  const unreadEl = document.getElementById('unread');
  const stateEl = document.getElementById('state');
  const layerEl = document.getElementById('layer');
  const LAYER_ICONS = { normal: '▢', top: '📌', desktop: '🖥', wallpaper: '🖼' };
  const LAYER_TITLES = {
    normal: 'Normal window',
    top: 'Always on top',
    desktop: 'On the desktop, below windows',
    wallpaper: 'On the wallpaper, below icons',
  };
  const hideEl = document.getElementById('hide');
  const settingsEl = document.getElementById('settings');

  let pending = null; // { workItemId, element }
  let running = false;
  let resolvedConversationId = conversationId;

  function scrollToEnd() {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function classFor(entry) {
    switch (entry.kind) {
      case 'owner': return 'entry entry-owner';
      case 'bot': return 'entry entry-bot';
      case 'tool_use':
      case 'tool_result': return 'entry entry-tool';
      case 'progress': return 'entry entry-progress';
      case 'error': return 'entry entry-error';
      default: return 'entry entry-system';
    }
  }

  function render(entry) {
    const element = document.createElement('div');
    element.className = classFor(entry);
    if (entry.kind === 'tool_use') {
      element.textContent = `⚙ ${entry.toolName || 'tool'} ${entry.text || ''}`.trim();
    } else if (entry.kind === 'tool_result') {
      element.textContent = `↳ ${entry.text || ''}`.trim();
    } else {
      element.textContent = entry.text;
    }
    if (entry.at && (entry.kind === 'owner' || entry.kind === 'bot')) {
      const meta = document.createElement('span');
      meta.className = 'entry-meta';
      const at = new Date(entry.at);
      meta.textContent = `${entry.kind === 'bot' && entry.origin === 'heartbeat' ? 'unprompted · ' : ''}${at.toLocaleTimeString()}`;
      element.appendChild(meta);
    }
    return element;
  }

  async function reload() {
    const entries = await api.invoke('transcript', resolvedConversationId);
    transcriptEl.replaceChildren(...entries.filter((entry) => entry.kind !== 'progress').map(render));
    pending = null;
    scrollToEnd();
  }

  function setRunning(value) {
    running = value;
    sendEl.disabled = value;
    cancelEl.hidden = !value;
    stateEl.textContent = value ? 'thinking…' : '';
  }

  async function refreshHeader() {
    const conversations = await api.invoke('listConversations');
    const record = conversations.find((item) => item.id === resolvedConversationId)
      || (conversationId === 'home' ? conversations.find((item) => item.role === 'home') : null);
    if (!record) return;
    resolvedConversationId = record.id;
    const profile = await api.invoke('getProfile');
    titleEl.textContent = record.role === 'home' ? profile.name : `${profile.name} · ${record.title}`;
    unreadEl.hidden = record.unreadCount === 0;
    unreadEl.textContent = String(record.unreadCount);
    const windowState = await api.window.state();
    showLayer(windowState.layer);
  }

  async function send() {
    const text = inputEl.value.trim();
    if (!text || running) return;
    inputEl.value = '';
    setRunning(true);
    try {
      await api.invoke('sendOwnerMessage', resolvedConversationId, text);
    } catch (error) {
      setRunning(false);
      const element = render({ kind: 'error', text: `Could not send: ${error && error.message ? error.message : String(error)}` });
      transcriptEl.appendChild(element);
      scrollToEnd();
    }
  }

  sendEl.addEventListener('click', () => { void send(); });
  inputEl.addEventListener('keydown', (event) => {
    // Enter that confirms an IME candidate (Chinese, Japanese, …) is not a send.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  });
  cancelEl.addEventListener('click', () => { void api.invoke('cancelTurn', resolvedConversationId); });
  hideEl.addEventListener('click', () => { void api.window.hide(); });
  settingsEl.addEventListener('click', () => { void api.shell.openSettings(); });
  function showLayer(layer) {
    layerEl.textContent = LAYER_ICONS[layer] || LAYER_ICONS.normal;
    layerEl.title = `${LAYER_TITLES[layer] || LAYER_TITLES.normal} (click to change)`;
  }
  layerEl.addEventListener('click', () => { void api.window.layerMenu(); });
  api.window.onLayer(showLayer);
  // A note on the desktop is lifted into an ordinary window when it is used; give the typing back to the input.
  api.window.onLifted(() => {
    if (!document.activeElement || document.activeElement === document.body) inputEl.focus();
  });
  window.addEventListener('focus', () => { void api.invoke('markSeen', resolvedConversationId).then(refreshHeader); });

  api.onEvent((event) => {
    if (event.type === 'turn.delta' && event.conversationId === resolvedConversationId) {
      if (event.entry.kind === 'bot') {
        if (!pending || pending.workItemId !== event.workItemId) {
          const element = document.createElement('div');
          element.className = 'entry entry-bot pending';
          pending = { workItemId: event.workItemId, element };
          transcriptEl.appendChild(element);
        }
        pending.element.textContent += event.entry.text;
        scrollToEnd();
      } else if (event.entry.kind !== 'progress') {
        transcriptEl.appendChild(render(event.entry));
        scrollToEnd();
      }
      return;
    }
    if (event.type === 'work.updated' && event.workItem.conversationId === resolvedConversationId) {
      if (event.workItem.state === 'running') setRunning(true);
      return;
    }
    if (event.type === 'turn.completed' && event.conversationId === resolvedConversationId) {
      setRunning(false);
      void reload().then(() => (document.hasFocus() ? api.invoke('markSeen', resolvedConversationId) : null)).then(refreshHeader);
      return;
    }
    if (event.type === 'conversation.updated' && event.conversation.id === resolvedConversationId) {
      void refreshHeader();
      if (!running) void reload();
      return;
    }
    if (event.type === 'runtime.status') {
      stateEl.textContent = event.state === 'ready' ? '' : `runtime ${event.state}`;
    }
  });

  void refreshHeader().then(reload).then(() => api.invoke('markSeen', resolvedConversationId)).then(refreshHeader);
})();

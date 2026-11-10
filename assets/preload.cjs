// The only bridge between a renderer (a sticky note, the settings page or
// the first-run setup, the floating bot) and the main process (SPEC-001
// FR-34, SPEC-002).
// Commands go to the core through `bot:invoke`; events come back on
// `bot:event`. Window-only actions use `window:*`, shell preferences
// `shell:*`, the floating bot `floating:*`, first-run setup `setup:*` and the
// hub's bot management `hub:*`;
// the main process checks which
// window sent each one. Nothing here can reach the runtime: the renderer never
// learns its URL or key. Plain CommonJS on purpose: sandboxed preload scripts
// cannot be ES modules.
const { contextBridge, ipcRenderer } = require('electron');

const params = new URLSearchParams(globalThis.location.search);

// SPEC-003 FR-10: dictation, where a native speech helper exists.
const voice = process.platform === 'darwin' || process.platform === 'win32'
  ? {
    start(options) {
      return ipcRenderer.invoke('note:voiceStart', options);
    },
    stop(sessionId) {
      return ipcRenderer.invoke('note:voiceStop', sessionId);
    },
    cancel(sessionId) {
      return ipcRenderer.invoke('note:voiceCancel', sessionId);
    },
    onEvent(listener) {
      const wrapped = (_event, payload) => listener(payload);
      ipcRenderer.on('note:voiceEvent', wrapped);
      return () => ipcRenderer.removeListener('note:voiceEvent', wrapped);
    },
  }
  : null;

contextBridge.exposeInMainWorld('catsBot', {
  voice,
  conversationId: params.get('conversation') || 'home',
  language: {
    get() {
      return ipcRenderer.invoke('ui:language');
    },
    set(value) {
      return ipcRenderer.invoke('ui:setLanguage', value);
    },
    onChange(listener) {
      const wrapped = (_event, state) => listener(state);
      ipcRenderer.on('ui:languageChanged', wrapped);
      return () => ipcRenderer.removeListener('ui:languageChanged', wrapped);
    },
  },
  // SPEC-008 FR-28: the reply language Cats Bot Settings sets for every bot.
  replyLanguage: {
    get() {
      return ipcRenderer.invoke('ui:replyLanguage');
    },
    set(value) {
      return ipcRenderer.invoke('ui:setReplyLanguage', value);
    },
  },
  invoke(command, ...args) {
    return ipcRenderer.invoke('bot:invoke', command, args);
  },
  onEvent(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('bot:event', wrapped);
    return () => {
      ipcRenderer.removeListener('bot:event', wrapped);
    };
  },
  onNavigate(listener) {
    const wrapped = (_event, tab) => listener(tab);
    ipcRenderer.on('settings:navigate', wrapped);
    return () => {
      ipcRenderer.removeListener('settings:navigate', wrapped);
    };
  },
  window: {
    hide() {
      return ipcRenderer.invoke('window:hide');
    },
    // SPEC-003 FR-9: a region screenshot for the composer.
    captureScreenshot() {
      return ipcRenderer.invoke('note:captureScreenshot', { source: 'composer' });
    },
    layerMenu() {
      return ipcRenderer.invoke('window:layerMenu');
    },
    onLayer(listener) {
      const wrapped = (_event, layer) => listener(layer);
      ipcRenderer.on('note:layer', wrapped);
      return () => {
        ipcRenderer.removeListener('note:layer', wrapped);
      };
    },
    onLifted(listener) {
      const wrapped = () => listener();
      ipcRenderer.on('note:lifted', wrapped);
      return () => {
        ipcRenderer.removeListener('note:lifted', wrapped);
      };
    },
    state() {
      return ipcRenderer.invoke('window:state');
    },
    openConversation(conversationId) {
      return ipcRenderer.invoke('window:open', conversationId);
    },
  },
  shell: {
    updateState() {
      return ipcRenderer.invoke('shell:updateState');
    },
    updateAction(action) {
      return ipcRenderer.invoke('shell:updateAction', action);
    },
    onUpdate(listener) {
      const wrapped = (_event, state) => listener(state);
      ipcRenderer.on('shell:update', wrapped);
      return () => ipcRenderer.removeListener('shell:update', wrapped);
    },
    state() {
      return ipcRenderer.invoke('shell:state');
    },
    setOpenAtLogin(enabled) {
      return ipcRenderer.invoke('shell:setOpenAtLogin', enabled);
    },
    chooseFolder(current) {
      return ipcRenderer.invoke('shell:chooseFolder', current);
    },
    openDataFolder() {
      return ipcRenderer.invoke('shell:openDataFolder');
    },
    openSettings(tab) {
      return ipcRenderer.invoke('shell:openSettings', tab);
    },
    openAgentClis() {
      return ipcRenderer.invoke('shell:openAgentClis');
    },
    setFloatingVisible(visible) {
      return ipcRenderer.invoke('shell:setFloatingVisible', visible);
    },
    noteLayers() {
      return ipcRenderer.invoke('shell:noteLayers');
    },
    setNoteLayer(conversationId, layer) {
      return ipcRenderer.invoke('shell:setNoteLayer', conversationId, layer);
    },
  },
  floating: {
    setInputRegions(regions) {
      ipcRenderer.send('floating:regions', regions);
    },
    setInteractive(interactive) {
      ipcRenderer.send('floating:interactive', interactive === true);
    },
    moveTo(x, y) {
      ipcRenderer.send('floating:moveTo', x, y);
    },
    dragEnd() {
      ipcRenderer.send('floating:dragEnd');
    },
    activate() {
      return ipcRenderer.invoke('floating:activate');
    },
    menu() {
      return ipcRenderer.invoke('floating:menu');
    },
    onBubble(listener) {
      const wrapped = (_event, message) => listener(message);
      ipcRenderer.on('floating:bubble', wrapped);
      return () => {
        ipcRenderer.removeListener('floating:bubble', wrapped);
      };
    },
  },
  setup: {
    check(provider) {
      return ipcRenderer.invoke('setup:check', provider);
    },
    install(provider, step, change) {
      return ipcRenderer.invoke('setup:install', provider, step, change);
    },
    providers() {
      return ipcRenderer.invoke('setup:providers');
    },
    models(provider) {
      return ipcRenderer.invoke('setup:models', provider);
    },
    prefill() {
      return ipcRenderer.invoke('setup:prefill');
    },
    suggestedAvatar() {
      return ipcRenderer.invoke('setup:suggestedAvatar');
    },
    finish(input) {
      return ipcRenderer.invoke('setup:finish', input);
    },
    cancel() {
      return ipcRenderer.invoke('setup:cancel');
    },
    openTerminal(provider) {
      return ipcRenderer.invoke('setup:openTerminal', provider);
    },
    openCodexInitialization() {
      return ipcRenderer.invoke('setup:openCodexInitialization');
    },
    environment() {
      return ipcRenderer.invoke('setup:environment');
    },
    folder(name) {
      return ipcRenderer.invoke('setup:folder', name);
    },
    draft() {
      return ipcRenderer.invoke('setup:draft');
    },
    restart(draft) {
      return ipcRenderer.invoke('setup:restart', draft);
    },
    onLog(listener) {
      const wrapped = (_event, entry) => listener(entry);
      ipcRenderer.on('setup:log', wrapped);
      return () => {
        ipcRenderer.removeListener('setup:log', wrapped);
      };
    },
  },
  // SPEC-012: Cats Bot Settings' Agent CLIs tab. Its runs report on `setup:log`.
  computer: {
    state() {
      return ipcRenderer.invoke('computer:state');
    },
    check() {
      return ipcRenderer.invoke('computer:check');
    },
    change(helper, change) {
      return ipcRenderer.invoke('computer:change', helper, change);
    },
    openTerminal(provider) {
      return ipcRenderer.invoke('computer:openTerminal', provider);
    },
    openCodexInitialization() {
      return ipcRenderer.invoke('computer:openCodexInitialization');
    },
  },
  // SPEC-008 FR-5: Settings → Bots; the hub asks before archiving or deleting.
  hub: {
    bots() {
      return ipcRenderer.invoke('hub:bots');
    },
    action(action, id, value) {
      return ipcRenderer.invoke('hub:botAction', action, id, value);
    },
    create() {
      return ipcRenderer.invoke('hub:createBot');
    },
    setLimits(limits) {
      return ipcRenderer.invoke('hub:setLimits', limits);
    },
    onChange(listener) {
      const wrapped = () => listener();
      ipcRenderer.on('hub:botsChanged', wrapped);
      return () => {
        ipcRenderer.removeListener('hub:botsChanged', wrapped);
      };
    },
  },
});

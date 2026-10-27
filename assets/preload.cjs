// The only bridge between a renderer (a sticky note, the settings page or
// the first-run setup) and the main process (SPEC-001 FR-34, SPEC-002).
// Commands go to the core through `bot:invoke`; events come back on
// `bot:event`. Window-only actions use `window:*`, shell preferences
// `shell:*`, and first-run setup `setup:*`; the main process checks which
// window sent each one. Nothing here can reach the runtime: the renderer never
// learns its URL or key. Plain CommonJS on purpose: sandboxed preload scripts
// cannot be ES modules.
const { contextBridge, ipcRenderer } = require('electron');

const params = new URLSearchParams(globalThis.location.search);

contextBridge.exposeInMainWorld('catsBot', {
  conversationId: params.get('conversation') || 'home',
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
    togglePin() {
      return ipcRenderer.invoke('window:togglePin');
    },
    state() {
      return ipcRenderer.invoke('window:state');
    },
    openConversation(conversationId) {
      return ipcRenderer.invoke('window:open', conversationId);
    },
  },
  shell: {
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
  },
  setup: {
    providers() {
      return ipcRenderer.invoke('setup:providers');
    },
    models(provider) {
      return ipcRenderer.invoke('setup:models', provider);
    },
    finish(input) {
      return ipcRenderer.invoke('setup:finish', input);
    },
  },
});

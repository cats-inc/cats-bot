// The only bridge between a sticky-note renderer and the main process
// (SPEC-001 FR-34). Commands go to the core through `bot:invoke`; events come
// back on `bot:event`. Window-only actions use `window:*`. Nothing here can
// reach the runtime: the renderer never learns its URL or key. Plain
// CommonJS on purpose: sandboxed preload scripts cannot be ES modules.
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
});

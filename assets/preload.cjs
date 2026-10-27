// The only bridge between a renderer (a sticky note, the settings page or
// the first-run setup, the floating bot) and the main process (SPEC-001
// FR-34, SPEC-002).
// Commands go to the core through `bot:invoke`; events come back on
// `bot:event`. Window-only actions use `window:*`, shell preferences
// `shell:*`, the floating bot `floating:*` and first-run setup `setup:*`;
// the main process checks which
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

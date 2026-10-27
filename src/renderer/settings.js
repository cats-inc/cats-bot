// The settings page and first-run setup (SPEC-002 FR-1–FR-6). Like the note
// renderer it holds no durable state: everything is read from and written to
// the core through the preload bridge. In setup mode no bot exists yet, so
// the page talks to the shell's setup channel instead.
(() => {
  const api = window.catsBot;
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') === 'setup' ? 'setup' : 'settings';
  const CUSTOM = '__custom__';

  const $ = (id) => document.getElementById(id);
  const toastEl = $('toast');
  let toastTimer = null;

  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
  }

  function errorText(error) {
    const message = error && error.message ? error.message : String(error);
    // Electron prefixes errors thrown in the main process.
    return message.replace(/^Error invoking remote method '[^']+': (Error: )?/u, '');
  }

  function providerLabel(provider) {
    const missing = provider.installed === false ? ' (not found)' : '';
    return `${provider.label} · ${provider.command}${missing}`;
  }

  function fillProviders(select, providers, current) {
    const list = [...providers];
    if (current && !list.some((provider) => provider.id === current)) {
      list.push({ id: current, label: current, command: current, installed: null });
    }
    select.replaceChildren(...list.map((provider) => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = providerLabel(provider);
      return option;
    }));
    select.value = current || (list.find((provider) => provider.installed) || list[0]).id;
    return list;
  }

  function providerHint(hintEl, providers, id) {
    const provider = providers.find((item) => item.id === id);
    hintEl.classList.toggle('warn', provider && provider.installed === false);
    if (!provider) {
      hintEl.textContent = '';
    } else if (provider.installed === false) {
      hintEl.textContent = `"${provider.command}" was not found on PATH. Install it and sign in once in a terminal before the bot can answer.`;
    } else if (provider.installed) {
      hintEl.textContent = `Uses your own "${provider.command}" sign-in and subscription.`;
    } else {
      hintEl.textContent = '';
    }
  }

  function fillModels(select, customEl, catalog, current) {
    const defaultModel = catalog.models.find((model) => model.id === catalog.defaultModel);
    const options = [{ value: '', text: `Provider default${defaultModel ? ` (${defaultModel.label})` : ''}` }];
    for (const model of catalog.models) options.push({ value: model.id, text: model.label === model.id ? model.id : `${model.label} · ${model.id}` });
    options.push({ value: CUSTOM, text: 'Other model id…' });
    select.replaceChildren(...options.map((entry) => {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.text;
      return option;
    }));
    if (!current) {
      select.value = '';
      customEl.value = '';
    } else if (catalog.models.some((model) => model.id === current)) {
      select.value = current;
      customEl.value = '';
    } else {
      select.value = CUSTOM;
      customEl.value = current;
    }
    customEl.hidden = select.value !== CUSTOM;
  }

  function readModel(select, customEl) {
    if (select.value === CUSTOM) return customEl.value.trim() || null;
    return select.value || null;
  }

  function bindCustomToggle(select, customEl) {
    select.addEventListener('change', () => {
      customEl.hidden = select.value !== CUSTOM;
      if (!customEl.hidden) customEl.focus();
    });
  }

  // Provider changes can overlap: only the newest request fills the model menu, and while it is
  // loading the old provider's models are gone and the form cannot be saved with them.
  function modelLoader(select, customEl, submitEl, fetchCatalog) {
    let latest = 0;
    let loading = false;
    return {
      get loading() { return loading; },
      async load(provider, current) {
        const request = ++latest;
        loading = true;
        submitEl.disabled = true;
        const placeholder = document.createElement('option');
        placeholder.textContent = 'Loading models…';
        select.replaceChildren(placeholder);
        select.disabled = true;
        customEl.hidden = true;
        let catalog;
        try {
          catalog = await fetchCatalog(provider);
        } catch {
          catalog = { provider, defaultModel: null, models: [], source: 'none' };
        }
        if (request !== latest) return null;
        fillModels(select, customEl, catalog, current);
        select.disabled = false;
        submitEl.disabled = false;
        loading = false;
        return catalog;
      },
    };
  }

  // ---------------------------------------------------------------- setup --
  async function startSetup() {
    $('setup').hidden = false;
    document.title = 'Set up Cats Bot';
    const providerEl = $('setup-provider');
    const modelEl = $('setup-model');
    const customEl = $('setup-model-custom');
    const hintEl = $('setup-provider-hint');
    const providers = await api.setup.providers();
    const preferred = providers.find((provider) => provider.id === 'claude' && provider.installed)
      || providers.find((provider) => provider.installed) || providers[0];
    fillProviders(providerEl, providers, preferred.id);
    const submit = $('setup-submit');
    const models = modelLoader(modelEl, customEl, submit, (provider) => api.setup.models(provider));
    const loadModels = async () => {
      providerHint(hintEl, providers, providerEl.value);
      await models.load(providerEl.value, null);
    };
    providerEl.addEventListener('change', () => { void loadModels(); });
    bindCustomToggle(modelEl, customEl);
    await loadModels();
    $('setup-name').focus();
    $('setup-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (models.loading) return;
      const errorEl = $('setup-error');
      errorEl.hidden = true;
      submit.disabled = true;
      submit.textContent = 'Starting…';
      try {
        await api.setup.finish({
          name: $('setup-name').value.trim(),
          provider: providerEl.value,
          model: readModel(modelEl, customEl),
          instructions: $('setup-instructions').value.trim(),
        });
      } catch (error) {
        errorEl.textContent = errorText(error);
        errorEl.hidden = false;
        submit.disabled = false;
        submit.textContent = 'Create and start';
      }
    });
  }

  // ------------------------------------------------------------- settings --
  let profile = null;
  let providers = [];
  let shellState = null;

  function selectTab(name) {
    for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.dataset.panel !== name;
    if (name === 'notes') void renderNotes();
    if (name === 'telegram') void renderTelegram();
    if (name === 'life') void renderLife();
    if (name === 'app') void renderApp();
  }

  async function renderBrand() {
    const status = await api.invoke('status');
    $('brand-name').textContent = status.name;
    const target = profile ? `${profile.executionTarget.provider}${profile.executionTarget.model ? ` · ${profile.executionTarget.model}` : ''}` : '';
    $('brand-state').textContent = `${target} · runtime ${status.runtime.state}`;
    document.title = `${status.name} Settings`;
  }

  // Bot tab
  async function renderBot() {
    profile = await api.invoke('getProfile');
    providers = await api.invoke('listProviders');
    $('bot-name').value = profile.name;
    fillProviders($('bot-provider'), providers, profile.executionTarget.provider);
    providerHint($('bot-provider-hint'), providers, profile.executionTarget.provider);
    await loadBotModels(profile.executionTarget.model);
    $('bot-instructions').value = profile.instructions;
    $('bot-cwd').value = profile.permissions.cwd;
    $('bot-access').value = profile.permissions.workspaceAccess;
    $('bot-permission').value = profile.permissions.permissionMode;
    $('bot-tools').value = (profile.permissions.allowedTools || []).join(', ');
    $('bot-tools-field').hidden = profile.permissions.permissionMode !== 'whitelist';
  }

  let botModels = null;

  async function loadBotModels(current) {
    botModels ??= modelLoader($('bot-model'), $('bot-model-custom'), $('bot-save'), (provider) => api.invoke('listModels', provider));
    $('bot-model-hint').textContent = '';
    const catalog = await botModels.load($('bot-provider').value, current);
    if (!catalog) return;
    $('bot-model-hint').textContent = catalog.source === 'runtime'
      ? 'Models reported by the running runtime.'
      : catalog.source === 'packaged' ? 'Models from the catalog shipped with cats-runtime.' : 'No catalog for this CLI; type a model id or keep the default.';
  }

  function sameList(a, b) {
    return JSON.stringify(a || []) === JSON.stringify(b || []);
  }

  async function saveBot(event) {
    event.preventDefault();
    if (botModels?.loading) return;
    const provider = $('bot-provider').value;
    const model = readModel($('bot-model'), $('bot-model-custom'));
    const permissionMode = $('bot-permission').value;
    const allowedTools = $('bot-tools').value.split(',').map((tool) => tool.trim()).filter(Boolean);
    const patch = {};
    if ($('bot-name').value.trim() && $('bot-name').value.trim() !== profile.name) patch.name = $('bot-name').value.trim();
    if (provider !== profile.executionTarget.provider || model !== profile.executionTarget.model) {
      patch.executionTarget = { provider, model };
    }
    if ($('bot-instructions').value !== profile.instructions) patch.instructions = $('bot-instructions').value;
    const permissions = {};
    if ($('bot-cwd').value.trim() && $('bot-cwd').value.trim() !== profile.permissions.cwd) permissions.cwd = $('bot-cwd').value.trim();
    if ($('bot-access').value !== profile.permissions.workspaceAccess) permissions.workspaceAccess = $('bot-access').value;
    if (permissionMode !== profile.permissions.permissionMode) permissions.permissionMode = permissionMode;
    if (permissionMode === 'whitelist' && !sameList(allowedTools, profile.permissions.allowedTools)) permissions.allowedTools = allowedTools;
    if (Object.keys(permissions).length > 0) patch.permissions = permissions;
    if (Object.keys(patch).length === 0) {
      toast('Nothing changed');
      return;
    }
    try {
      const before = profile;
      profile = await api.invoke('updateProfile', patch);
      const notice = $('bot-notice');
      const lines = [];
      if (profile.configRevision !== before.configRevision) {
        lines.push('Each conversation continues in a fresh session that gets a summary of what was said so far.');
      }
      if (patch.executionTarget && patch.executionTarget.provider !== before.executionTarget.provider) {
        lines.push(`The runtime restarts for ${provider} once the current reply has finished.`);
      }
      notice.textContent = lines.join(' ');
      notice.hidden = lines.length === 0;
      toast('Saved');
      await renderBrand();
    } catch (error) {
      toast(`Could not save: ${errorText(error)}`);
    }
  }

  // Notes tab
  const SESSION_WORDS = {
    none: 'not started yet',
    initializing: 'waking up',
    ready: 'awake',
    sleeping: 'asleep',
    closed: 'asleep',
    stale: 'restarts on the next message',
    failed: 'session failed',
  };

  function ago(iso) {
    if (!iso) return 'no messages yet';
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    return new Date(iso).toLocaleDateString();
  }

  function lastActivity(record) {
    const times = [record.lastOwnerMessageAt, record.lastBotMessageAt].filter(Boolean).sort();
    return times.length ? times[times.length - 1] : null;
  }

  let noteLayers = null;

  async function renderNotes() {
    noteLayers = await api.shell.noteLayers();
    const records = await api.invoke('listConversations');
    records.sort((a, b) => (a.role === 'home' ? -1 : b.role === 'home' ? 1 : (lastActivity(b) || b.createdAt).localeCompare(lastActivity(a) || a.createdAt)));
    const list = $('notes-list');
    list.replaceChildren(...records.map(noteRow));
  }

  function noteRow(record) {
    const row = document.createElement('li');
    row.className = 'note-row';
    row.dataset.id = record.id;
    const main = document.createElement('div');
    main.className = 'main';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = record.role === 'home' ? `${record.title}` : record.title;
    if (record.role === 'home') title.append(badge('home', 'home'));
    if (record.unreadCount) title.append(badge(`${record.unreadCount} unread`));
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${ago(lastActivity(record))} · ${SESSION_WORDS[record.attachment.state] || record.attachment.state}`;
    main.append(title, meta);

    const open = button('Open', () => { void api.window.openConversation(record.id); });
    const rename = button('Rename', () => startRename(row, record));
    row.append(main, layerSelect(record), open, rename);
    if (record.role !== 'home') {
      const remove = button('Delete', async () => {
        if (!remove.classList.contains('armed')) {
          remove.classList.add('armed');
          remove.textContent = 'Delete for good?';
          setTimeout(() => { remove.classList.remove('armed'); remove.textContent = 'Delete'; }, 4000);
          return;
        }
        try {
          await api.invoke('deleteConversation', record.id);
          toast(`Deleted ${record.title}`);
          await renderNotes();
        } catch (error) {
          toast(`Could not delete: ${errorText(error)}`);
        }
      });
      remove.classList.add('danger');
      row.append(remove);
    }
    return row;
  }

  function layerSelect(record) {
    const select = document.createElement('select');
    select.className = 'layer';
    select.title = 'Where this note lives';
    for (const layer of noteLayers.layers) {
      const option = document.createElement('option');
      option.value = layer;
      option.textContent = noteLayers.labels[layer];
      select.append(option);
    }
    select.value = noteLayers.views[record.id] || 'normal';
    select.addEventListener('change', async () => {
      await api.shell.setNoteLayer(record.id, select.value);
      toast(`${record.title}: ${noteLayers.labels[select.value]}`);
    });
    return select;
  }

  function badge(text, kind) {
    const element = document.createElement('span');
    element.className = `badge${kind ? ` ${kind}` : ''}`;
    element.textContent = text;
    return element;
  }

  function button(text, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = text;
    element.addEventListener('click', onClick);
    return element;
  }

  function startRename(row, record) {
    const main = row.querySelector('.main');
    const input = document.createElement('input');
    input.value = record.title;
    input.maxLength = 80;
    const save = async () => {
      const title = input.value.trim();
      if (!title || title === record.title) {
        await renderNotes();
        return;
      }
      try {
        await api.invoke('renameConversation', record.id, title);
        await renderNotes();
      } catch (error) {
        toast(`Could not rename: ${errorText(error)}`);
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') void save();
      if (event.key === 'Escape') void renderNotes();
    });
    input.addEventListener('blur', () => { void save(); });
    main.replaceChildren(input);
    for (const element of row.querySelectorAll('button')) element.hidden = true;
    input.focus();
    input.select();
  }

  // Life tab
  async function renderLife() {
    profile = await api.invoke('getProfile');
    const status = await api.invoke('status');
    $('life-heartbeat').checked = profile.heartbeat.enabled;
    $('life-wake-min').value = profile.heartbeat.wakeMinMinutes;
    $('life-wake-max').value = profile.heartbeat.wakeMaxMinutes;
    $('life-regular-min').value = profile.heartbeat.regularMinMinutes;
    $('life-regular-max').value = profile.heartbeat.regularMaxMinutes;
    $('life-idle').value = profile.idleSleepMinutes;
    $('life-next').textContent = status.heartbeat.enabled && status.heartbeat.nextAt
      ? `Next heartbeat around ${new Date(status.heartbeat.nextAt).toLocaleTimeString()}.`
      : status.heartbeat.enabled ? 'The next heartbeat is drawn once the bot is up.' : 'Heartbeat is paused.';
  }

  function minutes(id) {
    const value = Number($(id).value);
    if (!Number.isFinite(value) || value < 1) throw new Error('Minutes must be at least 1');
    return value;
  }

  async function saveLife(event) {
    event.preventDefault();
    try {
      const heartbeat = {
        enabled: $('life-heartbeat').checked,
        wakeMinMinutes: minutes('life-wake-min'),
        wakeMaxMinutes: minutes('life-wake-max'),
        regularMinMinutes: minutes('life-regular-min'),
        regularMaxMinutes: minutes('life-regular-max'),
      };
      profile = await api.invoke('updateProfile', { heartbeat, idleSleepMinutes: minutes('life-idle') });
      toast('Saved');
      await renderLife();
    } catch (error) {
      toast(`Could not save: ${errorText(error)}`);
    }
  }

  // Telegram tab
  async function renderTelegram() {
    profile = await api.invoke('getProfile');
    const status = await api.invoke('telegramStatus');
    const facts = [
      ['Token', status.tokenStored ? `stored, ${status.protection === 'os' ? 'encrypted by the OS' : 'in a plain file'}` : 'not set'],
      ['Polling', status.transport && status.transport.polling ? `on (${status.transport.health})` : 'off'],
      ['Owner chat', profile.telegram.ownerChatId !== null ? String(profile.telegram.ownerChatId) : 'not bound yet: send your bot a private message'],
    ];
    if (status.transport && status.transport.lastError) facts.push(['Last error', status.transport.lastError]);
    $('telegram-facts').replaceChildren(...facts.map(([label, value]) => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${label}: `;
      item.append(name, value);
      return item;
    }));
    $('telegram-enabled').checked = profile.telegram.enabled;
    $('telegram-clear').disabled = !status.tokenStored;
  }

  async function saveTelegramToken(event) {
    event.preventDefault();
    const token = $('telegram-token').value.trim();
    if (!token) {
      toast('Paste the token from @BotFather first');
      return;
    }
    try {
      await api.invoke('setTelegramToken', token);
      $('telegram-token').value = '';
      toast('Token saved');
      await renderTelegram();
    } catch (error) {
      toast(`Could not save: ${errorText(error)}`);
    }
  }

  // App tab
  async function renderApp() {
    shellState = await api.shell.state();
    const status = await api.invoke('status');
    $('app-login-row').hidden = !shellState.openAtLoginAvailable;
    $('app-login').checked = shellState.openAtLogin;
    $('app-floating').checked = shellState.floatingVisible;
    const facts = [
      ['Bot id', status.id],
      ['Data folder', status.root],
      ['Runtime', `${status.runtime.state}${status.runtime.pid ? ` (pid ${status.runtime.pid})` : ''}`],
      ['Version', shellState.version],
    ];
    $('app-facts').replaceChildren(...facts.map(([label, value]) => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${label}: `;
      item.append(name, value);
      return item;
    }));
  }

  async function startSettings() {
    $('settings').hidden = false;
    for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    $('bot-provider').addEventListener('change', () => {
      const provider = $('bot-provider').value;
      providerHint($('bot-provider-hint'), providers, provider);
      // Coming back to the saved provider shows its saved model again, so saving keeps it.
      void loadBotModels(provider === profile.executionTarget.provider ? profile.executionTarget.model : null);
    });
    bindCustomToggle($('bot-model'), $('bot-model-custom'));
    $('bot-permission').addEventListener('change', () => { $('bot-tools-field').hidden = $('bot-permission').value !== 'whitelist'; });
    $('bot-cwd-browse').addEventListener('click', async () => {
      const chosen = await api.shell.chooseFolder($('bot-cwd').value);
      if (chosen) $('bot-cwd').value = chosen;
    });
    $('bot-form').addEventListener('submit', (event) => { void saveBot(event); });
    $('notes-new').addEventListener('click', async () => {
      const record = await api.invoke('createConversation');
      await api.window.openConversation(record.id);
      await renderNotes();
    });
    $('life-form').addEventListener('submit', (event) => { void saveLife(event); });
    $('telegram-form').addEventListener('submit', (event) => { void saveTelegramToken(event); });
    $('telegram-enabled').addEventListener('change', async () => {
      await api.invoke('updateProfile', { telegram: { enabled: $('telegram-enabled').checked } });
      toast($('telegram-enabled').checked ? 'Telegram polling on' : 'Telegram polling off');
      await renderTelegram();
    });
    $('telegram-clear').addEventListener('click', async () => {
      await api.invoke('setTelegramToken', null);
      toast('Token removed');
      await renderTelegram();
    });
    $('app-login').addEventListener('change', async () => {
      await api.shell.setOpenAtLogin($('app-login').checked);
      toast($('app-login').checked ? 'Starts at sign-in' : 'No longer starts at sign-in');
    });
    $('app-floating').addEventListener('change', async () => {
      await api.shell.setFloatingVisible($('app-floating').checked);
      toast($('app-floating').checked ? 'The cat is back' : 'The cat is hidden; the tray can bring it back');
    });
    $('app-open-data').addEventListener('click', () => { void api.shell.openDataFolder(); });

    api.onEvent((event) => {
      if (event.type === 'conversation.updated' && !$('notes-list').closest('.panel').hidden
        && !document.activeElement?.closest?.('.note-row')) {
        void renderNotes();
      }
      if (event.type === 'runtime.status') void renderBrand();
    });
    api.onNavigate?.((tab) => selectTab(tab));
    // A note's layer can change from its own header; show the current one when the page comes back.
    window.addEventListener('focus', () => {
      if (!$('notes-list').closest('.panel').hidden) void renderNotes();
    });

    await renderBot();
    await renderBrand();
    selectTab(params.get('tab') || 'bot');
  }

  void (mode === 'setup' ? startSetup() : startSettings());
})();

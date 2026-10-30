import { createRoot } from 'react-dom/client';

import { SettingsApp } from './SettingsApp.tsx';
import { SetupPage } from './SetupPage.tsx';
import { initializeLanguage } from '../i18n.ts';

// SPEC-002 FR-1, FR-4: the same page is the first-run setup (?mode=setup), a new bot's setup
// (?mode=setup&purpose=create), a bot's settings window and the hub's Bots page (?scope=hub).
const params = new URLSearchParams(location.search);
const root = document.getElementById('root');
if (!root) throw new Error('settings.html has no #root');
void initializeLanguage().then(() =>
  createRoot(root).render(
    params.get('mode') === 'setup'
      ? <SetupPage purpose={params.get('purpose') === 'create' ? 'create' : 'first-run'} />
      : <SettingsApp initialTab={params.get('tab')} scope={params.get('scope') === 'hub' ? 'hub' : 'bot'} />,
  ),
);

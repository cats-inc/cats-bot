import { createRoot } from 'react-dom/client';

import { SettingsApp } from './SettingsApp.tsx';
import { SetupPage } from './SetupPage.tsx';
import { initializeLanguage } from '../i18n.ts';

// SPEC-002 FR-1, FR-4: the same page is the first-run setup (?mode=setup) and the settings window.
const params = new URLSearchParams(location.search);
const root = document.getElementById('root');
if (!root) throw new Error('settings.html has no #root');
void initializeLanguage().then(() =>
  createRoot(root).render(
    params.get('mode') === 'setup' ? <SetupPage /> : <SettingsApp initialTab={params.get('tab')} />,
  ),
);

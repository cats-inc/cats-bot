import { createRoot } from 'react-dom/client';

import { SettingsApp } from './SettingsApp.tsx';
import { SetupPage } from './SetupPage.tsx';

// SPEC-002 FR-1, FR-4: the same page is the first-run setup (?mode=setup) and the settings window.
const params = new URLSearchParams(location.search);
const root = document.getElementById('root');
if (!root) throw new Error('settings.html has no #root');
createRoot(root).render(params.get('mode') === 'setup' ? <SetupPage /> : <SettingsApp initialTab={params.get('tab')} />);

import { createRoot } from 'react-dom/client';

import { NoteApp } from './NoteApp.tsx';
import { initializeLanguage } from '../i18n.ts';

const root = document.getElementById('root');
if (!root) throw new Error('note.html has no #root');
void initializeLanguage().then(() => createRoot(root).render(<NoteApp />));

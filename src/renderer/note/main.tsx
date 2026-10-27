import { createRoot } from 'react-dom/client';

import { NoteApp } from './NoteApp.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('note.html has no #root');
createRoot(root).render(<NoteApp />);

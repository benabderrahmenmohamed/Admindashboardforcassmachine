import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { StartupError } from './app/StartupError';
import { createBackend } from './lib/backend';
import './styles/index.css';

const root = createRoot(document.getElementById('root')!);

createBackend().then(
  (backend) => root.render(<App backend={backend} />),
  (error: unknown) => {
    console.error('Startup failed', error);
    root.render(<StartupError error={error} />);
  },
);

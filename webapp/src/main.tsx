// Точка входа мини-приложения — docs/SPEC.md §7.1; тема и платформа берутся из MAX UI / Bridge (docs/DESIGN.md §1).
import '@maxhub/max-ui/dist/styles.css';
import './ui.css';

import { MaxUI } from '@maxhub/max-ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';
import { platform } from './bridge';

const container = document.getElementById('root');
if (!container) throw new Error('Не найден контейнер #root');

createRoot(container).render(
  <StrictMode>
    {/* colorScheme не задаём: MAX UI сам следит за prefers-color-scheme (DESIGN.md §1). */}
    <MaxUI platform={platform()} resetBody className="dg-app">
      <App />
    </MaxUI>
  </StrictMode>,
);

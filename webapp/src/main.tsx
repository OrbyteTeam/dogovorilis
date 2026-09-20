// СКЕЛЕТ. Реальные экраны описаны в docs/SPEC.md §7 и собираются по ЗАДАЧА_01.md.
import '@maxhub/max-ui/dist/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MaxUI, Panel, Typography } from '@maxhub/max-ui';

function App() {
  return (
    <MaxUI resetBody>
      <Panel centeredX centeredY>
        <Typography.Title>Договорились</Typography.Title>
        <Typography.Body>Скелет мини-приложения. Экраны — по docs/SPEC.md.</Typography.Body>
      </Panel>
    </MaxUI>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

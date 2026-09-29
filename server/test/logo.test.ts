// Логотип в репозитории (DESIGN_BRIEF §7, чек-лист §9 п. 13): файлы на месте и нужного размера, мини-приложение
// подключает их как favicon и иконку, Docker-образ несёт логотип для квитанции. Логотипа нет в текстах бота:
// сообщения и карточки остаются текстом (это держат render-cards и render-notices).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** Ширина и высота PNG из заголовка IHDR: без библиотек, файл проверяется как есть. */
function pngSize(rel: string): [number, number] {
  const bytes = readFileSync(path.join(REPO, rel));
  expect(bytes.subarray(1, 4).toString('latin1'), rel).toBe('PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('логотип (DESIGN_BRIEF §7)', () => {
  it.each([
    ['webapp/public/logo-512.png', 512],
    ['webapp/public/logo-192.png', 192],
    ['webapp/public/logo-white-192.png', 192],
    ['server/assets/logo.png', 512],
  ] as const)('%s: PNG %i×%i', (file, size) => {
    expect(pngSize(file)).toEqual([size, size]);
  });

  it('SVG залит синим логотипа, не акцентом MAX UI', () => {
    const svg = readFileSync(path.join(REPO, 'webapp/public/logo.svg'), 'utf8');
    expect(svg).toContain('#0152AA');
    expect(svg.toLowerCase()).not.toContain('#007aff');
  });

  it('мини-приложение подключает favicon, иконку и манифест', () => {
    const html = readFileSync(path.join(REPO, 'webapp/index.html'), 'utf8');
    expect(html).toContain('%BASE_URL%logo-192.png');
    expect(html).toContain('%BASE_URL%manifest.webmanifest');
    const manifest = JSON.parse(readFileSync(path.join(REPO, 'webapp/public/manifest.webmanifest'), 'utf8')) as { icons: { src: string }[] };
    expect(manifest.icons.map((i) => i.src)).toEqual(['logo-192.png', 'logo-512.png']);
  });

  it('Docker-образ копирует логотип квитанции', () => {
    expect(readFileSync(path.join(REPO, 'Dockerfile'), 'utf8')).toContain('COPY --from=build /app/server/assets ./server/assets');
  });
});

// Чипы примеров условий по нишам (DESIGN_BRIEF §5.3, блок «Услуга»; SPEC §7.6). Своих услуг пока нет (ЗАДАЧА_08 C),
// поэтому показываем ниш-примеры с подписью «пример». Без эмодзи: иконки в мини-приложении только на токенах.
import type { Template, TemplateKey } from '../types';

const STARTS_WITH_EMOJI = /^\p{Extended_Pictographic}️?\s*/u;

/** Сервер старше редизайна присылает подписи с эмодзи («💅 Красота»): убираем, чтобы вид не зависел от версии. */
function chipLabel(template: Template): string {
  return template.label.replace(STARTS_WITH_EMOJI, '').trim();
}

export interface TemplateChipsProps {
  items: Template[];
  value: TemplateKey | null;
  onSelect: (template: Template) => void;
  /** Подпись группы для скринридера: в форме сделки — шаблон, на пустом экране «Мои услуги» — примеры. */
  ariaLabel?: string;
}

export function TemplateChips({ items, value, onSelect, ariaLabel = 'Примеры условий' }: TemplateChipsProps) {
  return (
    <div className="dg-chips" role="group" aria-label={ariaLabel}>
      {items.map((template) => {
        const active = template.key === value;
        return (
          <button
            key={template.key}
            type="button"
            className={active ? 'dg-chip dg-chip_active' : 'dg-chip'}
            aria-pressed={active}
            onClick={() => onSelect(template)}
          >
            {chipLabel(template)}
          </button>
        );
      })}
    </div>
  );
}

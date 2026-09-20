// Чипы шаблонов — своего компонента в MAX UI нет, сделан на токенах: docs/DESIGN.md §4, шаблоны — docs/SPEC.md §7.6.
import type { Template, TemplateKey } from '../types';

const TEMPLATE_EMOJI: Record<TemplateKey, string> = {
  beauty: '💅',
  lesson: '📚',
  repair: '🔧',
  custom_order: '🎂',
  freelance: '💻',
  free: '✍️',
};

const STARTS_WITH_EMOJI = /^\p{Extended_Pictographic}/u;

function chipLabel(template: Template): string {
  const label = template.label.trim();
  if (STARTS_WITH_EMOJI.test(label)) return label;
  const emoji = TEMPLATE_EMOJI[template.key];
  return emoji ? `${emoji} ${label}` : label;
}

export interface TemplateChipsProps {
  items: Template[];
  value: TemplateKey | null;
  onSelect: (template: Template) => void;
}

export function TemplateChips({ items, value, onSelect }: TemplateChipsProps) {
  return (
    <div className="dg-chips" role="group" aria-label="Шаблон сделки">
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

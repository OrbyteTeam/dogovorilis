// Чипы «Выбрать услугу» в форме сделки (§7.6a, ЗАДАЧА_08 C) — как чипы шаблонов, на токенах (docs/DESIGN.md §4):
// название и цена; скрытая услуга прежней сделки помечена «скрыта». Повторное нажатие выбранного чипа снимает выбор.
import { formatRub } from '../format';
import type { ServiceChip } from '../services';
import type { Service } from '../types';

export interface ServiceChipsProps {
  chips: ServiceChip[];
  value: number | null;
  onSelect: (service: Service) => void;
}

export function ServiceChips({ chips, value, onSelect }: ServiceChipsProps) {
  return (
    <div className="dg-chips" role="group" aria-label="Мои услуги">
      {chips.map(({ service, hidden }) => {
        const active = service.id === value;
        return (
          <button
            key={service.id}
            type="button"
            className={active ? 'dg-chip dg-chip_service dg-chip_active' : 'dg-chip dg-chip_service'}
            aria-pressed={active}
            onClick={() => onSelect(service)}
          >
            <span className="dg-chip__title">{service.title}</span>
            <span className="dg-chip__price">{formatRub(service.price_rub)}</span>
            {hidden ? <span className="dg-chip__tag">скрыта</span> : null}
          </button>
        );
      })}
    </div>
  );
}

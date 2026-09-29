// Сумма (DESIGN_BRIEF §5.2): Typography.Title с табличными цифрами, формат «1 500 ₽».
import { Typography } from '@maxhub/max-ui';

import { formatKopecks } from '../format';

export function AmountText({ kopecks, className }: { kopecks: number; className?: string }) {
  return (
    <Typography.Title variant="small-strong" className={className ? `dg-amount ${className}` : 'dg-amount'}>
      {formatKopecks(kopecks)}
    </Typography.Title>
  );
}

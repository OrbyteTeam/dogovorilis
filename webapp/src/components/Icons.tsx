// Иконки 24 px на currentColor: в @maxhub/max-ui 0.5.0 только шеврон, крестик и лупа, а плюса, списка и шестерёнки
// для нижней панели нет (DESIGN_BRIEF §6: «если нужной нет, SVG 24 px на currentColor»). Цвет задаёт родитель токеном.
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 24, children, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

/** «Новая»: плюс в круге. */
export function IconPlusCircle(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

/** «Сделки»: список. */
export function IconList(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 6.5h11M9 12h11M9 17.5h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="4.75" cy="6.5" r="1.25" fill="currentColor" />
      <circle cx="4.75" cy="12" r="1.25" fill="currentColor" />
      <circle cx="4.75" cy="17.5" r="1.25" fill="currentColor" />
    </Svg>
  );
}

/** «Настройки»: шестерёнка. */
export function IconGear(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M10.3 3.6a1.7 1.7 0 0 1 3.4 0l.1.7a1.7 1.7 0 0 0 2.5 1.1l.6-.4a1.7 1.7 0 0 1 2.4 2.4l-.4.6a1.7 1.7 0 0 0 1.1 2.5l.7.1a1.7 1.7 0 0 1 0 3.4l-.7.1a1.7 1.7 0 0 0-1.1 2.5l.4.6a1.7 1.7 0 0 1-2.4 2.4l-.6-.4a1.7 1.7 0 0 0-2.5 1.1l-.1.7a1.7 1.7 0 0 1-3.4 0l-.1-.7a1.7 1.7 0 0 0-2.5-1.1l-.6.4a1.7 1.7 0 0 1-2.4-2.4l.4-.6a1.7 1.7 0 0 0-1.1-2.5l-.7-.1a1.7 1.7 0 0 1 0-3.4l.7-.1a1.7 1.7 0 0 0 1.1-2.5l-.4-.6a1.7 1.7 0 0 1 2.4-2.4l.6.4a1.7 1.7 0 0 0 2.5-1.1z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
    </Svg>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Svg size={20} {...props}>
      <rect x="8.5" y="8.5" width="11" height="12.5" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M15.5 5.5V5A2.5 2.5 0 0 0 13 2.5H6A2.5 2.5 0 0 0 3.5 5v8A2.5 2.5 0 0 0 6 15.5h.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </Svg>
  );
}

/** Пустое состояние: папка со сделками. */
export function IconEmpty(props: IconProps) {
  return (
    <Svg viewBox="0 0 24 24" {...props}>
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8.5 13.5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </Svg>
  );
}

/** Ошибка: круг с восклицанием. */
export function IconAlert(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7.5v5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16.3" r="1.1" fill="currentColor" />
    </Svg>
  );
}

/** Успех: круг с галочкой. */
export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="m8 12.3 2.7 2.7L16.2 9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** Замок: действие недоступно (править нельзя, чужая сделка). */
export function IconLock(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="1.6" />
    </Svg>
  );
}

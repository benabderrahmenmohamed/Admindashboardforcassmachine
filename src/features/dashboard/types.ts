import type { LucideIcon } from 'lucide-react';

/** One linked summary card at the top of the dashboard. */
export interface StatCard {
  readonly title: string;
  readonly value: number;
  readonly icon: LucideIcon;
  /** Tailwind text colour of the icon. */
  readonly color: string;
  /** Tailwind background colour behind the icon. */
  readonly bgColor: string;
  readonly link: string;
}

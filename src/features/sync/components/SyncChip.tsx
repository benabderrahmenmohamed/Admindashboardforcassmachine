import {
  Archive,
  CheckCircle2,
  CloudOff,
  PauseCircle,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { useNow } from '../hooks/useNow';
import { useOutboxSnapshot } from '../hooks/useOutbox';
import { syncChipView, type SyncTone } from './syncView';

/** How often the chip re-reads the clock, for "last sent 3 min ago". */
const TICK_MS = 15_000;

const TONE_STYLES: Record<SyncTone, string> = {
  synced: 'border-green-200 bg-green-50 text-green-800 hover:bg-green-100',
  working: 'border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100',
  pending: 'border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100',
  paused: 'border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100',
  conflict: 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100',
  failed: 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100',
};

const TONE_ICONS: Record<SyncTone, LucideIcon> = {
  synced: CheckCircle2,
  working: RefreshCw,
  pending: CloudOff,
  paused: PauseCircle,
  conflict: TriangleAlert,
  failed: TriangleAlert,
};

/**
 * Whether what this device wrote has reached the server, on every face. It leads to the face's
 * Conflicts screen, which is where anything the queue cannot settle on its own is dealt with. It is
 * 44 px tall because on the waiter's phone and the kitchen screen it is a touch target like any other.
 */
export function SyncChip({ conflictsPath }: { readonly conflictsPath: string }) {
  const { summary, state } = useOutboxSnapshot();
  const view = syncChipView(summary, state, useNow(TICK_MS));
  const Icon = TONE_ICONS[view.tone];
  const discarded = view.discarded === null ? '' : ` ${view.discarded.label}`;

  return (
    <Link
      to={conflictsPath}
      title={view.detail}
      // The words on the chip, in the order they are shown and with nothing between them, then the
      // sentence behind them: whoever can read the chip hears the same words first.
      aria-label={`Sync: ${view.label} ${view.lastAck}${discarded}. ${view.detail}`}
      className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 transition-colors ${TONE_STYLES[view.tone]}`}
    >
      <Icon
        className={`w-4 h-4 shrink-0 ${view.tone === 'working' ? 'animate-spin' : ''}`}
        aria-hidden="true"
      />
      {/* The spaces are for whatever reads the text in one run; the flex gap does the layout. */}
      <span className="text-sm font-semibold">{view.label}</span>{' '}
      <span className="hidden sm:inline text-xs">{view.lastAck}</span>{' '}
      {view.discarded && (
        // Grey whatever the tone, so a dead-letter list never reads louder than a live conflict.
        <span className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-white px-1.5 text-xs font-medium text-gray-700">
          <Archive className="h-3 w-3" aria-hidden="true" />
          {view.discarded.count}
          <span className="hidden sm:inline"> discarded</span>
        </span>
      )}
    </Link>
  );
}

import { createContext } from 'react';
import type { OutboxRuntime } from '../runtime';

/** Null until OutboxProvider has this device's queue open; the provider waits for it. */
export const OutboxContext = createContext<OutboxRuntime | null>(null);

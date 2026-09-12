import type { TerminalsPort } from '@/ports';
import { openSessionOn, sessionView } from './ledger';
import type { MemoryTerminal } from './store';
import { freshId, invalidField, perform, requireProfile, type MemoryContext } from './support';

const TERMINAL_CODE = /^[A-Z0-9]{1,8}$/;

/**
 * Terminal registration, as register_terminal: admin only. The first registration of a code
 * creates the terminal in the caller's shop; every later one bumps its epoch, so only the device
 * registered last can record. The result carries the counter to adopt and any open session.
 */
export function createMemoryTerminals(context: MemoryContext): TerminalsPort {
  const { store } = context;
  return {
    register: (code) =>
      perform(context, 'terminals.register', () => {
        const profile = requireProfile(context, ['admin']);
        const normalized = (typeof code === 'string' ? code : '').trim().toUpperCase();
        if (!TERMINAL_CODE.test(normalized)) {
          throw invalidField('code', 'A terminal code is 1 to 8 letters or digits.');
        }
        const existing = Array.from(store.terminals.values()).find(
          (terminal) => terminal.shopId === profile.shopId && terminal.code === normalized,
        );
        const terminal: MemoryTerminal = existing
          ? { ...existing, epoch: existing.epoch + 1 }
          : {
              id: freshId(context, store.terminals),
              shopId: profile.shopId,
              code: normalized,
              lastSeq: 0,
              epoch: 0,
              createdAt: context.now().toISOString(),
            };
        store.terminals.set(terminal.id, terminal);
        const open = openSessionOn(store, terminal.id);
        return {
          terminalId: terminal.id,
          code: terminal.code,
          lastSeq: terminal.lastSeq,
          epoch: terminal.epoch,
          openSession: open ? sessionView(store, open) : null,
        };
      }),
  };
}

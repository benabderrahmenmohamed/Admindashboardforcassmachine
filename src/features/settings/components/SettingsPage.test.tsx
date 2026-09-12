import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createHarness } from '@/test/harness';
import { SettingsPage } from './SettingsPage';

function textarea(label: string): HTMLTextAreaElement {
  const found = screen.getByLabelText(label);
  if (!(found instanceof HTMLTextAreaElement)) {
    throw new Error(`${label} is not a text area`);
  }
  return found;
}

describe('SettingsPage', () => {
  it("shows the shop's settings and this device's registration", async () => {
    const harness = await createHarness({ signedInAs: 'Admin', terminalCode: 'T1' });
    const settings = await harness.backend.settings.getSettings();

    harness.renderScreen(<SettingsPage />, { allow: ['admin'] });

    expect(await screen.findByText('Receipt')).toBeDefined();
    expect(textarea('Receipt Footer Message').value).toBe(settings.receiptFooter);
    // The terminal card is the admin's, and reads this device's registration off the queue.
    expect(screen.getByText('Terminal')).toBeDefined();
    expect(await screen.findByText('T1')).toBeDefined();
    expect(screen.getByText('None yet')).toBeDefined();
  });

  it('saves an edited receipt footer through the settings port', async () => {
    const harness = await createHarness({ signedInAs: 'Admin' });

    harness.renderScreen(<SettingsPage />, { allow: ['admin'] });
    await screen.findByText('Receipt');
    fireEvent.change(textarea('Receipt Footer Message'), { target: { value: 'À bientôt !' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Settings/ }));

    await waitFor(async () => {
      expect((await harness.backend.settings.getSettings()).receiptFooter).toBe('À bientôt !');
    });
  });
});

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { itemStage } from '@/features/orders/tableOrder';
import type { OpenOrderItem } from '@/ports';

/**
 * Taking something off a table always says why. The row is kept either way — the reason is what the
 * admin's report of items removed after they were sent is made of, and that report is the whole
 * reason removing is not a delete.
 */
export function RemoveItemDialog({
  item,
  onOpenChange,
  onConfirm,
  isRemoving,
}: {
  /** The row being taken off, or null when the dialog is closed. */
  readonly item: OpenOrderItem | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (reason: string) => void;
  readonly isRemoving: boolean;
}) {
  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Mounted afresh per row, so the reason typed for the last removal is never reused. */}
        {item !== null && (
          <RemoveForm
            key={item.id}
            item={item}
            onCancel={() => onOpenChange(false)}
            onConfirm={onConfirm}
            isRemoving={isRemoving}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RemoveForm({
  item,
  onCancel,
  onConfirm,
  isRemoving,
}: {
  readonly item: OpenOrderItem;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
  readonly isRemoving: boolean;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const wasSent = itemStage(item) !== 'unsent';

  return (
    <>
      <DialogHeader>
        <DialogTitle>Take {item.nameSnapshot} off the table?</DialogTitle>
        <DialogDescription>
          {wasSent
            ? 'The kitchen has already been told about this one, so it will show on their screen as a void, and it goes on the admin’s report of items removed after they were sent.'
            : 'The kitchen has not been told about this one yet.'}
        </DialogDescription>
      </DialogHeader>
      <form
        id="remove-item-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed !== '') {
            onConfirm(trimmed);
          }
        }}
      >
        <Label htmlFor="remove-reason">Why is it coming off?</Label>
        <Input
          id="remove-reason"
          className="mt-2 min-h-11"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Guest changed their mind"
          autoComplete="off"
          required
        />
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" className="min-h-11" onClick={onCancel}>
          Keep it
        </Button>
        <Button
          type="submit"
          form="remove-item-form"
          variant="destructive"
          className="min-h-11"
          disabled={trimmed === '' || isRemoving}
        >
          {isRemoving ? 'Removing…' : 'Take it off'}
        </Button>
      </DialogFooter>
    </>
  );
}

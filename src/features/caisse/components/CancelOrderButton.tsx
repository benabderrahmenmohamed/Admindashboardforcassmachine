import { Ban } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
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
import { useOrderWrites } from '@/features/orders/hooks/useOrders';
import type { RoomOrder } from '@/features/orders/overlay';
import type { DiningTable } from '@/ports';
import { cancelBlock } from '../cancel';

/**
 * Cashier and admin: cancels the order of a table nobody has paid for — the guests left, or the
 * table was never really theirs. The cancel goes into this device's queue like every order record,
 * so the rows show as cancelling at once, and it is offered only where the server would take it
 * (`cancelBlock`).
 */
export function CancelOrderButton({
  table,
  order,
}: {
  readonly table: DiningTable;
  /** The table as this device draws it. */
  readonly order: RoomOrder | null;
}) {
  const writes = useOrderWrites();
  const [isOpen, setIsOpen] = useState(false);

  if (cancelBlock(order) !== null) {
    return null;
  }

  const cancel = async (reason: string) => {
    if (await writes.cancelOrder({ tableId: table.id, reason })) {
      setIsOpen(false);
      toast.success(`${table.name}: order cancelled`);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 text-red-700"
        onClick={() => setIsOpen(true)}
      >
        <Ban className="h-4 w-4" />
        Cancel order
      </Button>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent>
          {/* Mounted again on every opening: one cancel's reason is never another's. */}
          {isOpen && (
            <CancelForm
              tableName={table.name}
              isCancelling={writes.isWriting}
              onKeep={() => setIsOpen(false)}
              onConfirm={(reason) => void cancel(reason)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function CancelForm({
  tableName,
  isCancelling,
  onKeep,
  onConfirm,
}: {
  readonly tableName: string;
  readonly isCancelling: boolean;
  readonly onKeep: () => void;
  readonly onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();

  return (
    <>
      <DialogHeader>
        <DialogTitle>Cancel the order of {tableName}?</DialogTitle>
        <DialogDescription>
          Everything on the table comes off, with this reason. Anything the kitchen had already been
          sent goes on the admin’s report of items removed after they were sent.
        </DialogDescription>
      </DialogHeader>
      <form
        id="cancel-order-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed !== '' && !isCancelling) {
            onConfirm(trimmed);
          }
        }}
      >
        <Label htmlFor="cancel-reason">Why is the order being cancelled?</Label>
        <Input
          id="cancel-reason"
          className="mt-2 min-h-11"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="The guests left"
          autoComplete="off"
          required
        />
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" className="min-h-11" onClick={onKeep}>
          Keep the order
        </Button>
        <Button
          type="submit"
          form="cancel-order-form"
          variant="destructive"
          className="min-h-11"
          disabled={trimmed === '' || isCancelling}
        >
          {isCancelling ? 'Cancelling…' : 'Cancel the order'}
        </Button>
      </DialogFooter>
    </>
  );
}

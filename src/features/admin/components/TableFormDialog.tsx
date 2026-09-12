import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useCreateTable, useUpdateTable } from '@/features/orders/hooks/useOrders';
import { errorMessage, isAppError } from '@/lib/errors';
import type { DiningTable } from '@/ports';
import {
  tableFormSchema,
  tableFormValues,
  takenNames,
  toDiningTableInput,
  type TableFormValues,
} from '../tableForm';

interface TableFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The table being edited, or null to add one. */
  readonly table: DiningTable | null;
  /** The whole room, retired tables included: where a new table goes, and the names in use. */
  readonly tables: readonly DiningTable[];
  /** True when an order is open on the table being edited. */
  readonly hasOpenOrder: boolean;
  /** Changes on every opening, so each opening starts from a fresh form. */
  readonly formSession: number;
}

/** Adding a table to the room, or renaming, moving or retiring one. A table is never deleted. */
export function TableFormDialog({
  open,
  onOpenChange,
  table,
  tables,
  hasOpenOrder,
  formSession,
}: TableFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{table ? `Edit ${table.name}` : 'Add a table'}</DialogTitle>
          <DialogDescription>
            The waiters and the counter see the tables in service, in the order of their position.
          </DialogDescription>
        </DialogHeader>
        {/* Keyed like the product form: Radix keeps the content mounted while it closes. */}
        <TableForm
          key={`${formSession}-${table?.id ?? 'new'}`}
          table={table}
          tables={tables}
          hasOpenOrder={hasOpenOrder}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function TableForm({
  table,
  tables,
  hasOpenOrder,
  onClose,
}: Omit<TableFormDialogProps, 'open' | 'onOpenChange' | 'formSession'> & {
  readonly onClose: () => void;
}) {
  const createTable = useCreateTable();
  const updateTable = useUpdateTable();
  // Fixed for the life of the form, like its starting values.
  const [schema] = useState(() =>
    tableFormSchema({ takenNames: takenNames(tables, table), hasOpenOrder }),
  );
  const form = useForm<TableFormValues>({
    resolver: zodResolver(schema),
    defaultValues: tableFormValues(table, tables),
  });
  const isSaving = createTable.isPending || updateTable.isPending || form.formState.isSubmitting;
  // An open order keeps the table in service; the box stays ticked and says why.
  const keepsService = hasOpenOrder && table?.isActive === true;

  const save = async (values: TableFormValues) => {
    try {
      const input = toDiningTableInput(values);
      if (table) {
        const saved = await updateTable.mutateAsync({ id: table.id, input });
        toast.success(`${saved.name} saved`);
      } else {
        const added = await createTable.mutateAsync(input);
        toast.success(`${added.name} added to the room`);
      }
      onClose();
    } catch (error) {
      // Another admin may have taken the name since the form opened: say it where it was typed.
      if (
        isAppError(error) &&
        error.code === 'VALIDATION_ERROR' &&
        error.details?.field === 'name'
      ) {
        form.setError('name', { message: error.message });
        return;
      }
      console.error('Error saving a table:', error);
      toast.error(errorMessage(error, 'The table could not be saved'));
    }
  };

  return (
    <Form {...form}>
      <form
        onSubmit={(event) => void form.handleSubmit(save)(event)}
        noValidate
        className="space-y-4"
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input {...field} autoComplete="off" placeholder="Terrasse 5" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="position"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Position</FormLabel>
              <FormControl>
                <Input {...field} inputMode="numeric" autoComplete="off" />
              </FormControl>
              <FormDescription>Lower numbers come first on the grid.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="isActive"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center gap-2">
                <FormControl>
                  <input
                    type="checkbox"
                    className="w-5 h-5"
                    checked={field.value}
                    disabled={keepsService}
                    onChange={(event) => field.onChange(event.target.checked)}
                    onBlur={field.onBlur}
                    name={field.name}
                    ref={field.ref}
                  />
                </FormControl>
                <FormLabel>In service</FormLabel>
              </div>
              <FormDescription>
                {keepsService
                  ? 'Guests are at this table: pay or cancel its order before taking it out of service.'
                  : 'A table out of service leaves the grid but keeps its name on the sales paid at it.'}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSaving}>
            {table ? 'Save table' : 'Add table'}
          </Button>
        </div>
      </form>
    </Form>
  );
}

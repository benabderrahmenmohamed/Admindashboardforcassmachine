import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useOutboxRecords } from '@/features/sync/hooks/useOutbox';
import { errorMessage } from '@/lib/errors';
import { useDeviceTerminal, useRegisterTerminal } from '../hooks/useTerminal';
import {
  registerBlockedReason,
  registerConfirmMessage,
  registerTerminalFormSchema,
  registrationSummary,
  type RegisterTerminalFormValues,
} from './registration';

/** Admin only: this device's terminal registration, and the form that registers it under a code. */
export function TerminalCard() {
  const terminalQuery = useDeviceTerminal();
  const records = useOutboxRecords();
  const terminal = terminalQuery.data ?? null;
  const registerTerminal = useRegisterTerminal();
  const form = useForm<RegisterTerminalFormValues>({
    resolver: zodResolver(registerTerminalFormSchema),
    // Registering the same code again is how a superseded device recovers, so it starts filled in.
    values: { code: terminal?.code ?? '' },
  });
  const summary = registrationSummary(terminal);
  // The store refuses too, in case the queue took a record since this render.
  const blockedReason = registerBlockedReason(records);
  const isRegistering = registerTerminal.isPending || form.formState.isSubmitting;

  const register = async ({ code }: RegisterTerminalFormValues) => {
    if (!confirm(registerConfirmMessage(code, terminal))) return;

    try {
      const registration = await registerTerminal.mutateAsync(code);
      toast.success(`This device is now terminal ${registration.code}`);
      form.reset({ code: registration.code });
    } catch (error) {
      console.error('Error registering terminal:', error);
      toast.error(errorMessage(error, 'Failed to register this device'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Terminal</CardTitle>
        <CardDescription>
          Register this device before selling on it. Receipts are numbered per terminal.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {summary ? (
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <dt className="text-sm text-gray-600">Terminal Code</dt>
              <dd className="text-lg font-semibold text-gray-900">{summary.code}</dd>
            </div>
            <div>
              <dt className="text-sm text-gray-600">Epoch</dt>
              <dd className="text-lg font-semibold text-gray-900">{summary.epoch}</dd>
            </div>
            <div>
              <dt className="text-sm text-gray-600">Last Receipt</dt>
              <dd className="text-lg font-semibold text-gray-900">
                {summary.lastReceipt ?? 'None yet'}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-gray-600">
            {terminalQuery.isPending
              ? 'Reading this device...'
              : 'This device is not registered as a terminal.'}
          </p>
        )}

        {blockedReason && (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {blockedReason}
          </p>
        )}

        <Form {...form}>
          <form onSubmit={(event) => void form.handleSubmit(register)(event)} noValidate>
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Register As</FormLabel>
                  <div className="flex gap-2">
                    <FormControl>
                      <Input {...field} placeholder="T1" autoComplete="off" className="max-w-40" />
                    </FormControl>
                    <Button type="submit" disabled={isRegistering || blockedReason !== null}>
                      {isRegistering ? 'Registering...' : 'Register Device'}
                    </Button>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

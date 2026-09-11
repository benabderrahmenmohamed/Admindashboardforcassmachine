import { zodResolver } from '@hookform/resolvers/zod';
import { Save } from 'lucide-react';
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
import { errorMessage } from '@/lib/errors';
import { shopSettingsSchema } from '@/ports';
import { useUpdateSettings } from '../hooks/useSettings';
import type { ShopSettings } from '../types';

export function SettingsForm({ settings }: { settings: ShopSettings }) {
  const updateSettings = useUpdateSettings();
  const form = useForm({
    resolver: zodResolver(shopSettingsSchema),
    // Follow the settings as they are refreshed (a cached value is shown first), but keep any
    // field the user has already edited, so Save never writes back an outdated footer by itself.
    values: settings,
    resetOptions: { keepDirtyValues: true },
  });

  const save = async (values: ShopSettings) => {
    try {
      await updateSettings.mutateAsync(values);
      toast.success('Settings saved successfully');
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to save settings'));
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={(event) => void form.handleSubmit(save)(event)} className="space-y-6">
        {/* Receipt Settings */}
        <Card>
          <CardHeader>
            <CardTitle>Receipt</CardTitle>
            <CardDescription>Text printed at the bottom of every receipt</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="receiptFooter"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Receipt Footer Message</FormLabel>
                  <FormControl>
                    <textarea
                      {...field}
                      className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="Thank you for your purchase!"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Save Button */}
        <div className="flex justify-end">
          <Button type="submit" disabled={updateSettings.isPending} size="lg">
            {updateSettings.isPending ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                Saving...
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                Save Settings
              </>
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}

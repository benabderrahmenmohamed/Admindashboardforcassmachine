import { zodResolver } from '@hookform/resolvers/zod';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/errors';
import { categoryInputSchema } from '@/ports';
import { useCreateCategory } from '../hooks/useCategories';
import type { CategoryColorOption, CategoryInput } from '../types';

const COLOR_OPTIONS: readonly CategoryColorOption[] = [
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Green', value: '#10b981' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Purple', value: '#8b5cf6' },
  { name: 'Orange', value: '#f59e0b' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'Teal', value: '#14b8a6' },
  { name: 'Indigo', value: '#6366f1' },
];

const EMPTY_CATEGORY: CategoryInput = {
  name: '',
  color: '#3b82f6',
};

/** The "Add Category" button and its dialog; creates the category and refreshes the list. */
export function CategoryFormDialog() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const createCategory = useCreateCategory();
  const form = useForm<CategoryInput>({
    resolver: zodResolver(categoryInputSchema),
    defaultValues: EMPTY_CATEGORY,
  });

  const resetForm = () => {
    form.reset(EMPTY_CATEGORY);
  };

  const handleSubmit = async (input: CategoryInput) => {
    try {
      await createCategory.mutateAsync(input);
      toast.success('Category created successfully');
      setIsDialogOpen(false);
      resetForm();
    } catch (error) {
      console.error('Error creating category:', error);
      toast.error(errorMessage(error, 'Failed to create category'));
    }
  };

  // isSubmitting turns on synchronously in the submit event, before the async validation, so a
  // fast double click cannot slip a second create in ahead of the mutation's pending state.
  const isSaving = createCategory.isPending || form.formState.isSubmitting;

  return (
    <Dialog
      open={isDialogOpen}
      onOpenChange={(open) => {
        setIsDialogOpen(open);
        // Reset on open as well as on close. The reset after a create runs inside handleSubmit,
        // which then marks the form submitted again, and a submitted form revalidates on every
        // keystroke; resetting here gives every opening the same clean state.
        resetForm();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Add Category
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Category</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={(e) => void form.handleSubmit(handleSubmit)(e)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category Name *</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., Beverages, Food, Desserts" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="color"
              render={({ field }) => (
                <FormItem>
                  <Label>Color</Label>
                  <div className="grid grid-cols-4 gap-2">
                    {COLOR_OPTIONS.map((color) => (
                      <button
                        key={color.value}
                        type="button"
                        onClick={() => field.onChange(color.value)}
                        aria-pressed={field.value === color.value}
                        className={`p-3 rounded-lg border-2 transition-all ${
                          field.value === color.value
                            ? 'border-gray-900 scale-105'
                            : 'border-gray-200 hover:border-gray-400'
                        }`}
                        style={{ backgroundColor: color.value }}
                      >
                        <span className="sr-only">{color.name}</span>
                      </button>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsDialogOpen(false);
                  resetForm();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving}>
                Create Category
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

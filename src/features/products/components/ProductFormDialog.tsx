import { zodResolver } from '@hookform/resolvers/zod';
import type { ReactElement } from 'react';
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
import { errorMessage } from '@/lib/errors';
import type { Category, Product } from '@/ports';
import { useCreateProduct, useUpdateProduct } from '../hooks/useProducts';
import {
  productFormSchema,
  toProductFormValues,
  toProductInput,
  type ProductFormValues,
} from '../schema';

interface ProductFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button that opens the dialog to add a product. */
  trigger: ReactElement;
  /** The product being edited, or null to add one. */
  product: Product | null;
  /** Changes on every opening of the dialog, so each opening starts from a fresh form. */
  formSession: number;
  categories: readonly Category[];
}

export function ProductFormDialog({
  open,
  onOpenChange,
  trigger,
  product,
  formSession,
  categories,
}: ProductFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{product ? 'Edit Product' : 'Add New Product'}</DialogTitle>
        </DialogHeader>
        {/*
          Keyed so the form starts from the values of the product it is opened for. The opening is
          part of the key because Radix keeps the content mounted through its closing animation:
          reopening the dialog during it would otherwise show the values typed before.
        */}
        <ProductForm
          key={`${formSession}-${product?.id ?? 'new'}`}
          product={product}
          categories={categories}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The reference's field wrapper. FormItem's own 'grid gap-2' would let the two-column grid stretch
 * its rows, pushing a field down whenever its neighbour is taller or shows an error.
 */
const FIELD_ITEM_CLASS = 'block space-y-2';

function ProductForm({
  product,
  categories,
  onClose,
}: {
  product: Product | null;
  categories: readonly Category[];
  onClose: () => void;
}) {
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: toProductFormValues(product ?? undefined),
  });
  // isSubmitting turns on synchronously in the submit event, before the async validation and before
  // the mutation's pending state reaches the screen, so a fast double click cannot save twice.
  const isSaving =
    createProduct.isPending || updateProduct.isPending || form.formState.isSubmitting;

  const save = async (values: ProductFormValues) => {
    try {
      const input = toProductInput(values);
      if (product) {
        await updateProduct.mutateAsync({ id: product.id, input });
        toast.success('Product updated successfully');
      } else {
        await createProduct.mutateAsync(input);
        toast.success('Product created successfully');
      }
      onClose();
    } catch (error) {
      console.error('Error saving product:', error);
      toast.error(errorMessage(error, 'Failed to save product'));
    }
  };

  return (
    <Form {...form}>
      {/*
        noValidate: the schema's messages show under each field instead of browser popups, and
        react-hook-form focuses the first invalid field on submit.
      */}
      <form onSubmit={(e) => void form.handleSubmit(save)(e)} noValidate className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem className={FIELD_ITEM_CLASS}>
                <FormLabel>Product Name *</FormLabel>
                <FormControl>
                  <Input {...field} required />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="price"
            render={({ field }) => (
              <FormItem className={FIELD_ITEM_CLASS}>
                <FormLabel>Price *</FormLabel>
                <FormControl>
                  <Input {...field} type="text" inputMode="decimal" required />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="categoryId"
            render={({ field }) => (
              <FormItem className={FIELD_ITEM_CLASS}>
                <FormLabel>Category</FormLabel>
                <FormControl>
                  <select
                    {...field}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">Select category</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="barcode"
            render={({ field }) => (
              <FormItem className={FIELD_ITEM_CLASS}>
                <FormLabel>Barcode</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="stock"
            render={({ field }) => (
              <FormItem className={FIELD_ITEM_CLASS}>
                <FormLabel>Stock Quantity</FormLabel>
                <FormControl>
                  <Input {...field} type="number" min="0" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem className={FIELD_ITEM_CLASS}>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <textarea
                  {...field}
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="imageUrl"
          render={({ field }) => (
            <FormItem className={FIELD_ITEM_CLASS}>
              <FormLabel>Image URL</FormLabel>
              <FormControl>
                <Input {...field} type="url" placeholder="https://example.com/image.jpg" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSaving}>
            {product ? 'Update Product' : 'Create Product'}
          </Button>
        </div>
      </form>
    </Form>
  );
}

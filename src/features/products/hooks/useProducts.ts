import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBackend } from '@/lib/backend-context';
import { queryKeys } from '@/lib/query';
import type { ProductCreateInput, ProductUpdateInput, StockAdjustment } from '@/ports';

export function useProducts() {
  const { catalog } = useBackend();
  return useQuery({
    queryKey: queryKeys.products,
    queryFn: () => catalog.listProducts(),
  });
}

export function useCreateProduct() {
  const { catalog } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProductCreateInput) => catalog.createProduct(input),
    // Not awaited: the save is done; the list refreshes in the background.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.products });
    },
  });
}

export function useUpdateProduct() {
  const { catalog } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ProductUpdateInput }) =>
      catalog.updateProduct(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.products });
    },
  });
}

/**
 * The daily sold-out toggle. It is a change to the menu of the day, not to the product, so it is
 * its own write: a waiter may use it, and it never touches a price or a name.
 */
export function useSetAvailability() {
  const { catalog } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isAvailable }: { id: string; isAvailable: boolean }) =>
      catalog.setAvailability(id, isAvailable),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.products });
    },
  });
}

/** Admin: corrects counted stock, leaving the movement behind as the reason. */
export function useAdjustStock() {
  const { catalog } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (adjustment: StockAdjustment) => catalog.adjustStock(adjustment),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.products });
    },
  });
}

/** Archives the product: it leaves the catalog, and sales that name it keep pointing at it. */
export function useDeleteProduct() {
  const { catalog } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => catalog.deleteProduct(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.products });
    },
  });
}

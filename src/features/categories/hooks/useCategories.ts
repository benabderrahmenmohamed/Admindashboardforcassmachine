import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBackend } from '@/lib/backend-context';
import { queryKeys } from '@/lib/query';
import type { CategoryInput } from '@/ports';

export function useCategories() {
  const { catalog } = useBackend();
  return useQuery({
    queryKey: queryKeys.categories,
    queryFn: () => catalog.listCategories(),
  });
}

export function useCreateCategory() {
  const { catalog } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CategoryInput) => catalog.createCategory(input),
    // Products can link to a new category too: the Supabase backend matches them by name. Not
    // awaited: the save is done; the lists refresh in the background.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.categories });
      void queryClient.invalidateQueries({ queryKey: queryKeys.products });
    },
  });
}

export function useDeleteCategory() {
  const { catalog } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => catalog.deleteCategory(id),
    // Products show their category, so both lists can change. Not awaited, as above.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.categories });
      void queryClient.invalidateQueries({ queryKey: queryKeys.products });
    },
  });
}

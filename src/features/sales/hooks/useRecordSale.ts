import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useBackend } from '@/lib/backend-context';
import { queryKeys } from '@/lib/query';
import type { RecordSaleInput } from '@/ports';

export function useRecordSale() {
  const { sales } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RecordSaleInput) => sales.recordSale(input),
    // Recording a sale changes stock. Not awaited: the sale is recorded, and the cashier's
    // confirmation must not wait for the catalog to reload.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.products });
    },
  });
}

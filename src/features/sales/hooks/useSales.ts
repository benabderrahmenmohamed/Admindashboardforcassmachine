import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBackend } from '@/lib/backend-context';
import { queryKeys } from '@/lib/query';
import type { ListSalesQuery, VoidReceiptInput } from '@/ports';

/** Sales and refunds, newest first. Pass null to wait until the query is known. */
export function useSales(query: ListSalesQuery | null) {
  const { sales } = useBackend();
  return useQuery({
    queryKey: queryKeys.salesList(query ?? {}),
    queryFn: query === null ? skipToken : () => sales.listSales(query),
  });
}

/** One sale with its lines and what has been refunded of each. Pass null for none. */
export function useSale(id: string | null) {
  const { sales } = useBackend();
  return useQuery({
    queryKey: queryKeys.sale(id ?? ''),
    queryFn: id === null ? skipToken : () => sales.getSale(id),
  });
}

/** Admin only: voids a numbered record that can never be accepted, keeping numbering gapless. */
export function useVoidReceipt() {
  const { sales } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: VoidReceiptInput) => sales.voidReceipt(input),
    // Not awaited: the void is stored; the lists and the running report refresh in the background.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sales });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

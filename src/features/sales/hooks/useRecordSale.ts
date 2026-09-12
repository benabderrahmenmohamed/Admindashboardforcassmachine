import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useBackend } from '@/lib/backend-context';
import { queryKeys } from '@/lib/query';
import type { SaleRecord } from '@/ports';

/**
 * Records a sale or a refund built with src/features/sales/records.ts. Sending the same record again
 * is safe: the server answers 'replayed' with the same receipt number.
 */
export function useRecordSale() {
  const { sales } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (record: SaleRecord) => sales.recordSale(record),
    // A record changes stock, the sales list and the session's running report. Not awaited: the
    // record is stored, and the cashier's confirmation must not wait for those to reload.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.products });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sales });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

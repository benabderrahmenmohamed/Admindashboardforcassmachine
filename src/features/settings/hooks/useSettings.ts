import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBackend } from '@/lib/backend-context';
import { queryKeys } from '@/lib/query';
import type { ShopSettings } from '@/ports';

export function useSettings() {
  const { settings } = useBackend();
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => settings.getSettings(),
  });
}

export function useUpdateSettings() {
  const { settings } = useBackend();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (next: ShopSettings) => settings.updateSettings(next),
    onSuccess: (saved) => queryClient.setQueryData(queryKeys.settings, saved),
  });
}

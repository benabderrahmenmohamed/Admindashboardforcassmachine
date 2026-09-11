import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { Toaster } from '@/components/ui/sonner';
import { AuthProvider } from '@/features/auth/components/AuthProvider';
import { BackendProvider } from '@/lib/backend-context';
import { createQueryClient } from '@/lib/query';
import type { Backend } from '@/ports';
import { router } from '@/routes/router';

export function App({ backend }: { backend: Backend }) {
  const [queryClient] = useState(createQueryClient);

  return (
    <BackendProvider backend={backend}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
          <Toaster position="top-right" />
        </AuthProvider>
      </QueryClientProvider>
    </BackendProvider>
  );
}

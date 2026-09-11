import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/errors';

/** Spinner for a page section while its data loads. */
export function LoadingState() {
  return (
    <div className="flex items-center justify-center h-64" role="status" aria-label="Loading">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
    </div>
  );
}

/** Spinner for the whole screen while the session is restored. */
export function FullPageLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center" role="status">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
        <p className="mt-4 text-gray-600">Loading...</p>
      </div>
    </div>
  );
}

/** A failed load, with its message and an optional retry. */
export function ErrorState({
  error,
  onRetry,
  title = 'Something went wrong',
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center px-4" role="alert">
      <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
      <p className="font-semibold text-gray-900 mb-1">{title}</p>
      <p className="text-sm text-gray-600 mb-4">{errorMessage(error, 'Please try again.')}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

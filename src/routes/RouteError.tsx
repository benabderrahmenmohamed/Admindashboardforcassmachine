import { useRouteError } from 'react-router';
import { ErrorState } from '@/components/feedback';

/** Shown in place of a screen that failed to render, instead of the router's bare error page. */
export function RouteError() {
  const error = useRouteError();
  return (
    <div className="min-h-screen flex items-center justify-center">
      <ErrorState
        error={error}
        title="This screen could not be shown"
        onRetry={() => window.location.reload()}
      />
    </div>
  );
}

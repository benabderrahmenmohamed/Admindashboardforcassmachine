import { errorMessage } from '@/lib/errors';

/** Shown instead of the app when the backend cannot be built, e.g. a missing environment variable. */
export function StartupError({ error }: { error: unknown }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <div className="max-w-md text-center" role="alert">
        <p className="text-lg font-semibold text-gray-900">The app could not start</p>
        <p className="mt-2 text-sm text-gray-600">{errorMessage(error, 'Unknown startup error')}</p>
      </div>
    </div>
  );
}

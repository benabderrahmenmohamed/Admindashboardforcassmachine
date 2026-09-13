import { FolderTree, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ErrorState, LoadingState } from '@/components/feedback';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { errorMessage } from '@/lib/errors';
import { useCategories, useDeleteCategory } from '../hooks/useCategories';
import { CategoryFormDialog } from './CategoryFormDialog';

export function CategoriesPage() {
  const categoriesQuery = useCategories();
  const deleteCategory = useDeleteCategory();
  // The mutation only reports its latest call, so every in-flight id is tracked here: each row's
  // button stays disabled until its own delete and the refetch after it have finished.
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set());

  // A failed refresh (after a delete, say) keeps the last list on screen, so it is reported here.
  useEffect(() => {
    if (categoriesQuery.isRefetchError) {
      toast.error(errorMessage(categoriesQuery.error, 'Failed to fetch categories'));
    }
  }, [categoriesQuery.isRefetchError, categoriesQuery.error]);

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this category?')) return;

    setDeletingIds((ids) => new Set(ids).add(id));
    try {
      await deleteCategory.mutateAsync(id);
      toast.success('Category deleted successfully');
    } catch (error) {
      console.error('Error deleting category:', error);
      toast.error(errorMessage(error, 'Failed to delete category'));
    } finally {
      setDeletingIds((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    }
  };

  if (categoriesQuery.isPending) {
    return <LoadingState />;
  }

  // Only a failed first load replaces the page; a failed refresh keeps the list (see above).
  if (categoriesQuery.isLoadingError) {
    return (
      <ErrorState
        title="Failed to fetch categories"
        error={categoriesQuery.error}
        onRetry={() => void categoriesQuery.refetch()}
      />
    );
  }

  const categories = categoriesQuery.data;

  return (
    <div>
      <div className="mb-8 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Categories</h1>
          <p className="text-gray-600">Organize your products with categories</p>
        </div>
        <CategoryFormDialog />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderTree className="w-5 h-5" />
            Categories ({categories.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {categories.length === 0 ? (
            <div className="text-center py-12">
              <FolderTree className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600 mb-2">No categories yet</p>
              <p className="text-sm text-gray-500">
                Create your first category to organize products
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {categories.map((category) => (
                <Card key={category.id} className="border-2">
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div
                          className="w-10 h-10 rounded-lg"
                          style={{ backgroundColor: category.color }}
                        />
                        <div>
                          <h3 className="font-semibold text-gray-900">{category.name}</h3>
                          <p className="text-xs text-gray-500">
                            {new Date(category.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete ${category.name}`}
                        onClick={() => void handleDelete(category.id)}
                        disabled={deletingIds.has(category.id)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

import { Package, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ErrorState, LoadingState } from '@/components/feedback';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCategories } from '@/features/categories/hooks/useCategories';
import { errorMessage } from '@/lib/errors';
import { formatTND } from '@/lib/money';
import type { Product } from '@/ports';
import { useDeleteProduct, useProducts } from '../hooks/useProducts';
import { ProductFormDialog } from './ProductFormDialog';

export function ProductsPage() {
  const productsQuery = useProducts();
  // The form's category select needs them.
  const categoriesQuery = useCategories();
  const deleteProduct = useDeleteProduct();
  const [searchTerm, setSearchTerm] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  // Counts the openings of the dialog; each one starts a fresh form (see ProductFormDialog).
  const [formSession, setFormSession] = useState(0);
  // The mutation only reports its latest call, so every in-flight id is tracked here: each row's
  // delete button stays disabled until its own delete has finished.
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set());

  // A failed refresh (after a delete, say) keeps the last list on screen, so it is reported here.
  useEffect(() => {
    if (productsQuery.isRefetchError) {
      toast.error(errorMessage(productsQuery.error, 'Failed to fetch products'));
    }
  }, [productsQuery.isRefetchError, productsQuery.error]);

  const handleDialogOpenChange = (open: boolean) => {
    // Only the Add Product trigger opens the dialog through here.
    if (open) setFormSession((session) => session + 1);
    setIsDialogOpen(open);
    if (!open) setEditingProduct(null);
  };

  const handleEdit = (product: Product) => {
    setEditingProduct(product);
    setFormSession((session) => session + 1);
    setIsDialogOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (
      !confirm(
        'Are you sure you want to archive this product? It leaves the catalog; past sales keep it.',
      )
    )
      return;

    setDeletingIds((ids) => new Set(ids).add(id));
    try {
      await deleteProduct.mutateAsync(id);
      toast.success('Product archived successfully');
    } catch (error) {
      console.error('Error archiving product:', error);
      toast.error(errorMessage(error, 'Failed to archive product'));
    } finally {
      setDeletingIds((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    }
  };

  // One retry reloads everything that failed, so a page where both loads failed needs one click.
  const retryFailedQueries = () => {
    if (productsQuery.isLoadingError) void productsQuery.refetch();
    if (categoriesQuery.isLoadingError) void categoriesQuery.refetch();
  };

  // A retry puts a query that never loaded back to pending, so the spinner shows while it runs.
  if (productsQuery.isPending || categoriesQuery.isPending) {
    return <LoadingState />;
  }

  // Only a failed first load replaces the page; a failed refresh keeps the list (see above).
  if (productsQuery.isLoadingError) {
    return (
      <ErrorState
        title="Failed to load products"
        error={productsQuery.error}
        onRetry={retryFailedQueries}
      />
    );
  }

  if (categoriesQuery.isLoadingError) {
    return (
      <ErrorState
        title="Failed to load categories"
        error={categoriesQuery.error}
        onRetry={retryFailedQueries}
      />
    );
  }

  // The dialog follows the listed product, so the current stock it shows is the latest one loaded.
  const listedEditingProduct =
    editingProduct &&
    (productsQuery.data.find((product) => product.id === editingProduct.id) ?? editingProduct);

  const term = searchTerm.toLowerCase();
  const filteredProducts = productsQuery.data.filter(
    (product) =>
      product.name.toLowerCase().includes(term) ||
      (product.categoryName ?? '').toLowerCase().includes(term) ||
      product.barcode.toLowerCase().includes(term),
  );

  return (
    <div>
      <div className="mb-8 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Products</h1>
          <p className="text-gray-600">Manage your product inventory</p>
        </div>
        <ProductFormDialog
          open={isDialogOpen}
          onOpenChange={handleDialogOpenChange}
          product={listedEditingProduct}
          formSession={formSession}
          categories={categoriesQuery.data}
          trigger={
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Add Product
            </Button>
          }
        />
      </div>

      {/* Search */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
            <Input
              placeholder="Search products by name, category, or barcode..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </CardContent>
      </Card>

      {/* Products List */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="w-5 h-5" />
            Products ({filteredProducts.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {filteredProducts.length === 0 ? (
            <div className="text-center py-12">
              <Package className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600 mb-2">No products found</p>
              <p className="text-sm text-gray-500">
                {searchTerm ? 'Try adjusting your search' : 'Add your first product to get started'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Stock</TableHead>
                    <TableHead>Barcode</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredProducts.map((product) => (
                    <TableRow key={product.id}>
                      <TableCell className="font-medium">{product.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{product.categoryName || 'Uncategorized'}</Badge>
                      </TableCell>
                      <TableCell>{formatTND(product.priceMillimes)}</TableCell>
                      <TableCell>
                        {/* Most café items are not counted at all, and stock never blocks a sale. */}
                        {product.trackStock ? (
                          <Badge
                            variant={
                              product.stockQty > 10
                                ? 'default'
                                : product.stockQty > 0
                                  ? 'secondary'
                                  : 'destructive'
                            }
                          >
                            {product.stockQty}
                          </Badge>
                        ) : (
                          <span className="text-sm text-gray-500">Not counted</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm">{product.barcode || '-'}</TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Edit ${product.name}`}
                            onClick={() => handleEdit(product)}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Archive ${product.name}`}
                            disabled={deletingIds.has(product.id)}
                            onClick={() => void handleDelete(product.id)}
                          >
                            <Trash2 className="w-4 h-4 text-red-600" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

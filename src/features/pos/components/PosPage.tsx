import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ErrorState, LoadingState } from '@/components/feedback';
import { useCategories } from '@/features/categories/hooks/useCategories';
import { useProducts } from '@/features/products/hooks/useProducts';
import { useRecordSale } from '@/features/sales/hooks/useRecordSale';
import { errorMessage } from '@/lib/errors';
import { addItem, emptyCart, removeLine, setQty, totals } from '../cart';
import { addToCartProblem, filterProducts, quantityProblem, toRecordSaleInput } from '../selling';
import type { Cart, PaymentMethod, Product } from '../types';
import { BarcodeScanner } from './BarcodeScanner';
import { CartPanel } from './CartPanel';
import { CheckoutDialog } from './CheckoutDialog';
import { ProductFilters } from './ProductFilters';
import { ProductGrid } from './ProductGrid';

export function PosPage() {
  const productsQuery = useProducts();
  const categoriesQuery = useCategories();
  const recordSale = useRecordSale();
  const [cart, setCart] = useState<Cart>(emptyCart);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [barcodeInput, setBarcodeInput] = useState('');

  // A failed refresh (after a sale, say) keeps the last list on screen, so it has to be reported
  // here: products with a toast as before, categories in the console as before.
  useEffect(() => {
    if (productsQuery.isRefetchError) {
      toast.error(errorMessage(productsQuery.error, 'Failed to fetch products'));
    }
  }, [productsQuery.isRefetchError, productsQuery.error]);

  useEffect(() => {
    if (categoriesQuery.isRefetchError) {
      console.error('Error fetching categories:', categoriesQuery.error);
    }
  }, [categoriesQuery.isRefetchError, categoriesQuery.error]);

  const products = productsQuery.data;
  const categories = categoriesQuery.data;

  if (products === undefined || categories === undefined) {
    const loadError =
      (products === undefined ? productsQuery.error : null) ??
      (categories === undefined ? categoriesQuery.error : null);
    if (loadError && !productsQuery.isFetching && !categoriesQuery.isFetching) {
      return (
        <ErrorState
          error={loadError}
          onRetry={() => {
            if (productsQuery.isError) {
              void productsQuery.refetch();
            }
            if (categoriesQuery.isError) {
              void categoriesQuery.refetch();
            }
          }}
        />
      );
    }
    return <LoadingState />;
  }

  const cartTotals = totals(cart);
  const filteredProducts = filterProducts(products, searchTerm, selectedCategoryId);

  const addToCart = (product: Product) => {
    const problem = addToCartProblem(cart, product);
    if (problem) {
      toast.error(problem);
      return;
    }
    setCart(addItem(cart, product));
    toast.success(`${product.name} added to cart`);
  };

  const updateQuantity = (productId: string, change: number) => {
    const product = products.find((candidate) => candidate.id === productId);
    const line = cart.lines.find((candidate) => candidate.productId === productId);

    if (!product || !line) return;

    const newQuantity = line.qty + change;
    const problem = quantityProblem(product, newQuantity);
    if (problem) {
      toast.error(problem);
      return;
    }
    // Zero removes the line.
    setCart(setQty(cart, productId, newQuantity));
  };

  const removeFromCart = (productId: string) => {
    setCart(removeLine(cart, productId));
  };

  const handleCompletePayment = async () => {
    if (cart.lines.length === 0) {
      toast.error('Cart is empty');
      return;
    }

    try {
      await recordSale.mutateAsync(toRecordSaleInput(cart, paymentMethod));
    } catch (error) {
      console.error('Error processing payment:', error);
      toast.error(errorMessage(error, 'Payment processing failed'));
      return;
    }
    toast.success('Payment completed successfully!');
    setCart(emptyCart);
    setIsPaymentDialogOpen(false);
  };

  const handleBarcodeSearch = () => {
    const barcode = barcodeInput.trim();
    if (!barcode) return;

    const product = products.find((candidate) => candidate.barcode === barcode);

    if (product) {
      addToCart(product);
      setBarcodeInput('');
    } else {
      toast.error('Product not found');
    }
  };

  return (
    <div className="max-w-[1600px] mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Products Section */}
        <div className="lg:col-span-2 space-y-4">
          <BarcodeScanner
            value={barcodeInput}
            onChange={setBarcodeInput}
            onSubmit={handleBarcodeSearch}
          />

          <ProductFilters
            searchTerm={searchTerm}
            onSearchTermChange={setSearchTerm}
            categories={categories}
            selectedCategoryId={selectedCategoryId}
            onSelectCategory={setSelectedCategoryId}
          />

          <ProductGrid products={filteredProducts} onAddProduct={addToCart} />
        </div>

        {/* Cart Section */}
        <div className="space-y-4">
          <CartPanel
            lines={cart.lines}
            totalMillimes={cartTotals.totalMillimes}
            onUpdateQuantity={updateQuantity}
            onRemove={removeFromCart}
            onCheckout={() => setIsPaymentDialogOpen(true)}
          />
        </div>
      </div>

      <CheckoutDialog
        open={isPaymentDialogOpen}
        onOpenChange={setIsPaymentDialogOpen}
        totalMillimes={cartTotals.totalMillimes}
        paymentMethod={paymentMethod}
        onPaymentMethodChange={setPaymentMethod}
        onConfirm={() => void handleCompletePayment()}
        isConfirming={recordSale.isPending}
      />
    </div>
  );
}

import { AlertCircle, ShoppingCart } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatTND } from '@/lib/money';
import { isSellable } from '../selling';
import type { Product } from '../types';

interface ProductGridProps {
  readonly products: readonly Product[];
  /** Called only for products that can be sold; the others are dimmed and ignore clicks. */
  readonly onAddProduct: (product: Product) => void;
}

export function ProductGrid({ products, onAddProduct }: ProductGridProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} onAddProduct={onAddProduct} />
      ))}
    </div>
  );
}

interface ProductCardProps {
  readonly product: Product;
  readonly onAddProduct: (product: Product) => void;
}

function ProductCard({ product, onAddProduct }: ProductCardProps) {
  const sellable = isSellable(product);
  return (
    <Card
      className={`cursor-pointer transition-all hover:shadow-lg ${
        !sellable ? 'opacity-50 cursor-not-allowed' : ''
      }`}
      onClick={() => {
        if (sellable) {
          onAddProduct(product);
        }
      }}
    >
      <CardContent className="p-4">
        <div className="aspect-square bg-gray-100 rounded-lg mb-3 flex items-center justify-center">
          {product.imageUrl ? (
            <img
              src={product.imageUrl}
              alt={product.name}
              className="w-full h-full object-cover rounded-lg"
            />
          ) : (
            <ShoppingCart className="w-12 h-12 text-gray-400" />
          )}
        </div>
        <h3 className="font-semibold text-sm mb-1 line-clamp-2">{product.name}</h3>
        <div className="flex items-center justify-between">
          <p className="text-lg font-bold text-blue-600">{formatTND(product.priceMillimes)}</p>
          {product.stock <= 10 && product.stock > 0 ? (
            <Badge variant="secondary" className="text-xs">
              <AlertCircle className="w-3 h-3 mr-1" />
              {product.stock} left
            </Badge>
          ) : product.stock <= 0 ? (
            <Badge variant="destructive" className="text-xs">
              Out of stock
            </Badge>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

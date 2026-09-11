import { CreditCard, Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTND, type Millimes } from '@/lib/money';
import type { CartLine } from '../types';

interface CartPanelProps {
  readonly lines: readonly CartLine[];
  readonly totalMillimes: Millimes;
  /** `change` is +1 or -1 units. */
  readonly onUpdateQuantity: (productId: string, change: number) => void;
  readonly onRemove: (productId: string) => void;
  /** Opens the payment dialog; the button is disabled while the cart is empty. */
  readonly onCheckout: () => void;
}

export function CartPanel({
  lines,
  totalMillimes,
  onUpdateQuantity,
  onRemove,
  onCheckout,
}: CartPanelProps) {
  return (
    <Card className="sticky top-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShoppingCart className="w-5 h-5" />
          Current Order
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3 max-h-[400px] overflow-y-auto mb-4">
          {lines.length === 0 ? (
            <p className="text-center text-gray-500 py-8">Cart is empty</p>
          ) : (
            lines.map((line) => (
              <div
                key={line.productId}
                className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg"
              >
                <div className="flex-1">
                  <p className="font-medium text-sm">{line.name}</p>
                  <p className="text-xs text-gray-600">{formatTND(line.unitPriceMillimes)} each</p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onUpdateQuantity(line.productId, -1)}
                  >
                    <Minus className="w-3 h-3" />
                  </Button>
                  <span className="w-8 text-center font-bold">{line.qty}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onUpdateQuantity(line.productId, 1)}
                  >
                    <Plus className="w-3 h-3" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onRemove(line.productId)}>
                    <Trash2 className="w-4 h-4 text-red-600" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="border-t pt-4 space-y-3">
          <div className="flex justify-between text-2xl font-bold">
            <span>Total:</span>
            <span>{formatTND(totalMillimes)}</span>
          </div>
          <Button
            className="w-full"
            size="lg"
            disabled={lines.length === 0}
            onClick={() => onCheckout()}
          >
            <CreditCard className="mr-2" />
            Checkout
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

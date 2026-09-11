import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { edgeFunctionUrl, env } from '../../lib/env';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { toast } from 'sonner';
import {
  ShoppingCart,
  Search,
  Plus,
  Minus,
  Trash2,
  CreditCard,
  Utensils,
  Barcode as BarcodeIcon,
  Check,
  AlertCircle,
} from 'lucide-react';

interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  barcode: string;
  stock: number;
  available: boolean;
  image?: string;
}

interface Category {
  id: string;
  name: string;
}

interface CartItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

interface Order {
  id: string;
  tableNumber: number | null;
  items: CartItem[];
  total: number;
  status: string;
  createdAt: string;
}

export function POS() {
  const { accessToken } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [loading, setLoading] = useState(true);
  const [posMode, setPosMode] = useState<'table' | 'barcode'>('table');
  const [tableNumber, setTableNumber] = useState('');
  const [orders, setOrders] = useState<Order[]>([]);
  const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [barcodeInput, setBarcodeInput] = useState('');

  const fetchProducts = async () => {
    try {
      const response = await fetch(`${edgeFunctionUrl}/products`, {
        headers: {
          Authorization: `Bearer ${env.supabaseAnonKey}`,
        },
      });
      const data = (await response.json()) as { products?: Product[] };
      if (response.ok) {
        setProducts(data.products || []);
      }
    } catch (error) {
      console.error('Error fetching products:', error);
      toast.error('Failed to fetch products');
    } finally {
      setLoading(false);
    }
  };

  const fetchCategories = async () => {
    try {
      const response = await fetch(`${edgeFunctionUrl}/categories`, {
        headers: {
          Authorization: `Bearer ${env.supabaseAnonKey}`,
        },
      });
      const data = (await response.json()) as { categories?: Category[] };
      if (response.ok) {
        setCategories(data.categories || []);
      }
    } catch (error) {
      console.error('Error fetching categories:', error);
    }
  };

  const fetchSettings = async () => {
    try {
      const response = await fetch(`${edgeFunctionUrl}/settings`, {
        headers: {
          Authorization: `Bearer ${env.supabaseAnonKey}`,
        },
      });
      const data = (await response.json()) as { settings?: { mode?: 'table' | 'barcode' } };
      if (response.ok && data.settings) {
        setPosMode(data.settings.mode || 'table');
      }
    } catch (error) {
      console.error('Error fetching settings:', error);
    }
  };

  const fetchOrders = async (token: string | null) => {
    try {
      const response = await fetch(`${edgeFunctionUrl}/orders`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = (await response.json()) as { orders?: Order[] };
      if (response.ok) {
        setOrders(data.orders || []);
      }
    } catch (error) {
      console.error('Error fetching orders:', error);
    }
  };

  // The mount effect loads orders with the token from the first render, as it always has.
  const mountAccessToken = useRef(accessToken);

  useEffect(() => {
    void fetchProducts();
    void fetchCategories();
    void fetchSettings();
    void fetchOrders(mountAccessToken.current);
  }, []);

  const addToCart = (product: Product) => {
    if (!product.available || product.stock <= 0) {
      toast.error('Product is out of stock');
      return;
    }

    const existingItem = cart.find((item) => item.productId === product.id);

    if (existingItem) {
      if (existingItem.quantity >= product.stock) {
        toast.error(`Only ${product.stock} items available`);
        return;
      }
      setCart(
        cart.map((item) =>
          item.productId === product.id ? { ...item, quantity: item.quantity + 1 } : item,
        ),
      );
    } else {
      setCart([
        ...cart,
        {
          productId: product.id,
          name: product.name,
          price: product.price,
          quantity: 1,
        },
      ]);
    }
    toast.success(`${product.name} added to cart`);
  };

  const updateQuantity = (productId: string, change: number) => {
    const product = products.find((p) => p.id === productId);
    const cartItem = cart.find((item) => item.productId === productId);

    if (!product || !cartItem) return;

    const newQuantity = cartItem.quantity + change;

    if (newQuantity > product.stock) {
      toast.error(`Only ${product.stock} items available`);
      return;
    }

    if (newQuantity <= 0) {
      setCart(cart.filter((item) => item.productId !== productId));
    } else {
      setCart(
        cart.map((item) =>
          item.productId === productId ? { ...item, quantity: newQuantity } : item,
        ),
      );
    }
  };

  const removeFromCart = (productId: string) => {
    setCart(cart.filter((item) => item.productId !== productId));
  };

  const calculateTotal = () => {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  };

  const handlePlaceOrder = async () => {
    if (cart.length === 0) {
      toast.error('Cart is empty');
      return;
    }

    if (posMode === 'table' && !tableNumber) {
      toast.error('Please enter a table number');
      return;
    }

    try {
      const response = await fetch(`${edgeFunctionUrl}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          items: cart,
          tableNumber: posMode === 'table' ? parseInt(tableNumber) : null,
          orderType: posMode,
        }),
      });

      const data = (await response.json()) as { error?: string };

      if (response.ok) {
        toast.success('Order placed successfully!');
        setCart([]);
        setTableNumber('');
        void fetchOrders(accessToken);
        void fetchProducts(); // Refresh to update stock
      } else {
        toast.error(data.error || 'Failed to place order');
      }
    } catch (error) {
      console.error('Error placing order:', error);
      toast.error('Failed to place order');
    }
  };

  const handleCompletePayment = async () => {
    if (cart.length === 0) {
      toast.error('Cart is empty');
      return;
    }

    if (posMode === 'barcode') {
      // For barcode mode, create order and complete immediately
      try {
        const orderResponse = await fetch(`${edgeFunctionUrl}/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            items: cart,
            tableNumber: null,
            orderType: 'instant',
          }),
        });

        const orderData = (await orderResponse.json()) as {
          order: { id: string };
          error?: string;
        };

        if (orderResponse.ok) {
          // Complete payment immediately
          const paymentResponse = await fetch(
            `${edgeFunctionUrl}/orders/${orderData.order.id}/complete`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({ paymentMethod }),
            },
          );

          const paymentData = (await paymentResponse.json()) as { error?: string };

          if (paymentResponse.ok) {
            toast.success('Payment completed successfully!');
            setCart([]);
            setIsPaymentDialogOpen(false);
            void fetchOrders(accessToken);
            void fetchProducts();
          } else {
            toast.error(paymentData.error || 'Payment failed');
          }
        } else {
          toast.error(orderData.error || 'Failed to create order');
        }
      } catch (error) {
        console.error('Error processing payment:', error);
        toast.error('Payment processing failed');
      }
    } else {
      // For table mode, just place the order
      void handlePlaceOrder();
      setIsPaymentDialogOpen(false);
    }
  };

  const handleCompleteOrder = async (orderId: string) => {
    try {
      const response = await fetch(`${edgeFunctionUrl}/orders/${orderId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ paymentMethod: 'cash' }),
      });

      const data = (await response.json()) as { error?: string };

      if (response.ok) {
        toast.success('Order completed successfully!');
        void fetchOrders(accessToken);
        void fetchProducts();
      } else {
        toast.error(data.error || 'Failed to complete order');
      }
    } catch (error) {
      console.error('Error completing order:', error);
      toast.error('Failed to complete order');
    }
  };

  const handleBarcodeSearch = () => {
    if (!barcodeInput.trim()) return;

    const product = products.find((p) => p.barcode === barcodeInput.trim());

    if (product) {
      addToCart(product);
      setBarcodeInput('');
    } else {
      toast.error('Product not found');
    }
  };

  const filteredProducts = products.filter((product) => {
    const matchesSearch = product.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'all' || product.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="max-w-[1600px] mx-auto">
      {/* Mode Indicator */}
      <div className="mb-4">
        <Badge className="text-lg py-2 px-4">
          {posMode === 'table' ? (
            <>
              <Utensils className="w-5 h-5 mr-2" />
              Table Mode
            </>
          ) : (
            <>
              <BarcodeIcon className="w-5 h-5 mr-2" />
              Barcode Mode
            </>
          )}
        </Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Products Section */}
        <div className="lg:col-span-2 space-y-4">
          {/* Barcode Scanner for Barcode Mode */}
          {posMode === 'barcode' && (
            <Card>
              <CardContent className="pt-6">
                <div className="flex gap-2">
                  <Input
                    placeholder="Scan or enter barcode..."
                    value={barcodeInput}
                    onChange={(e) => setBarcodeInput(e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        handleBarcodeSearch();
                      }
                    }}
                    className="text-lg"
                  />
                  <Button onClick={handleBarcodeSearch}>
                    <BarcodeIcon className="w-5 h-5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Search and Filter */}
          <Card>
            <CardContent className="pt-6">
              <div className="space-y-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                  <Input
                    placeholder="Search products..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10"
                  />
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Button
                    variant={selectedCategory === 'all' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSelectedCategory('all')}
                  >
                    All
                  </Button>
                  {categories.map((cat) => (
                    <Button
                      key={cat.id}
                      variant={selectedCategory === cat.name ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setSelectedCategory(cat.name)}
                    >
                      {cat.name}
                    </Button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Products Grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {filteredProducts.map((product) => (
              <Card
                key={product.id}
                className={`cursor-pointer transition-all hover:shadow-lg ${
                  !product.available || product.stock <= 0 ? 'opacity-50 cursor-not-allowed' : ''
                }`}
                onClick={() => product.available && product.stock > 0 && addToCart(product)}
              >
                <CardContent className="p-4">
                  <div className="aspect-square bg-gray-100 rounded-lg mb-3 flex items-center justify-center">
                    {product.image ? (
                      <img
                        src={product.image}
                        alt={product.name}
                        className="w-full h-full object-cover rounded-lg"
                      />
                    ) : (
                      <ShoppingCart className="w-12 h-12 text-gray-400" />
                    )}
                  </div>
                  <h3 className="font-semibold text-sm mb-1 line-clamp-2">{product.name}</h3>
                  <div className="flex items-center justify-between">
                    <p className="text-lg font-bold text-blue-600">${product.price.toFixed(2)}</p>
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
            ))}
          </div>
        </div>

        {/* Cart Section */}
        <div className="space-y-4">
          <Card className="sticky top-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShoppingCart className="w-5 h-5" />
                Current Order
              </CardTitle>
            </CardHeader>
            <CardContent>
              {posMode === 'table' && (
                <div className="mb-4">
                  <Input
                    placeholder="Table Number"
                    type="number"
                    value={tableNumber}
                    onChange={(e) => setTableNumber(e.target.value)}
                    className="text-center text-lg font-bold"
                  />
                </div>
              )}

              <div className="space-y-3 max-h-[400px] overflow-y-auto mb-4">
                {cart.length === 0 ? (
                  <p className="text-center text-gray-500 py-8">Cart is empty</p>
                ) : (
                  cart.map((item) => (
                    <div
                      key={item.productId}
                      className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg"
                    >
                      <div className="flex-1">
                        <p className="font-medium text-sm">{item.name}</p>
                        <p className="text-xs text-gray-600">${item.price.toFixed(2)} each</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => updateQuantity(item.productId, -1)}
                        >
                          <Minus className="w-3 h-3" />
                        </Button>
                        <span className="w-8 text-center font-bold">{item.quantity}</span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => updateQuantity(item.productId, 1)}
                        >
                          <Plus className="w-3 h-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeFromCart(item.productId)}
                        >
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
                  <span>${calculateTotal().toFixed(2)}</span>
                </div>
                <Button
                  className="w-full"
                  size="lg"
                  disabled={cart.length === 0 || (posMode === 'table' && !tableNumber)}
                  onClick={() => setIsPaymentDialogOpen(true)}
                >
                  <CreditCard className="mr-2" />
                  {posMode === 'table' ? 'Place Order' : 'Checkout'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Active Orders for Table Mode */}
          {posMode === 'table' && orders.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Active Tables</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {orders.map((order) => (
                    <div key={order.id} className="p-3 bg-gray-50 rounded-lg">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <p className="font-bold">Table {order.tableNumber}</p>
                          <p className="text-sm text-gray-600">
                            {order.items.length} items - ${order.total.toFixed(2)}
                          </p>
                        </div>
                        <Button size="sm" onClick={() => void handleCompleteOrder(order.id)}>
                          <Check className="w-4 h-4 mr-1" />
                          Pay
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Payment Dialog */}
      <Dialog open={isPaymentDialogOpen} onOpenChange={setIsPaymentDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Complete {posMode === 'table' ? 'Order' : 'Payment'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-gray-50 p-4 rounded-lg">
              <p className="text-sm text-gray-600">Total Amount:</p>
              <p className="text-3xl font-bold">${calculateTotal().toFixed(2)}</p>
            </div>
            {posMode === 'barcode' && (
              <div className="space-y-2">
                <p className="font-semibold">Payment Method:</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant={paymentMethod === 'cash' ? 'default' : 'outline'}
                    onClick={() => setPaymentMethod('cash')}
                  >
                    Cash
                  </Button>
                  <Button
                    variant={paymentMethod === 'card' ? 'default' : 'outline'}
                    onClick={() => setPaymentMethod('card')}
                  >
                    Card
                  </Button>
                </div>
              </div>
            )}
            <Button className="w-full" size="lg" onClick={() => void handleCompletePayment()}>
              <Check className="mr-2" />
              Confirm
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

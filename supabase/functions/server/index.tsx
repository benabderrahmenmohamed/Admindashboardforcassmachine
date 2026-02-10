import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { createClient } from "npm:@supabase/supabase-js";
import * as kv from "./kv_store.tsx";

const app = new Hono();

// Create Supabase client
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

// Enable logger
app.use('*', logger(console.log));

// Enable CORS for all routes and methods
app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

// Health check endpoint
app.get("/make-server-81f0b18a/health", (c) => {
  return c.json({ status: "ok" });
});

// ============ AUTH ROUTES ============

// Signup route
app.post("/make-server-81f0b18a/signup", async (c) => {
  try {
    const { email, password, name, role } = await c.req.json();
    
    if (!email || !password || !name) {
      return c.json({ error: "Email, password, and name are required" }, 400);
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      user_metadata: { name, role: role || 'worker' },
      // Automatically confirm the user's email since an email server hasn't been configured.
      email_confirm: true
    });

    if (error) {
      console.log(`Error creating user during signup: ${error.message}`);
      return c.json({ error: error.message }, 400);
    }

    return c.json({ user: data.user });
  } catch (error) {
    console.log(`Unexpected error during signup: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// ============ PRODUCT ROUTES ============

// Get all products
app.get("/make-server-81f0b18a/products", async (c) => {
  try {
    const products = await kv.getByPrefix('product:');
    return c.json({ products });
  } catch (error) {
    console.log(`Error fetching products: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// Get single product
app.get("/make-server-81f0b18a/products/:id", async (c) => {
  try {
    const id = c.req.param('id');
    const product = await kv.get(`product:${id}`);
    
    if (!product) {
      return c.json({ error: "Product not found" }, 404);
    }
    
    return c.json({ product });
  } catch (error) {
    console.log(`Error fetching product: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// Create product (admin only)
app.post("/make-server-81f0b18a/products", async (c) => {
  try {
    const accessToken = c.req.header('Authorization')?.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    
    if (!user || authError) {
      return c.json({ error: "Unauthorized - admin access required" }, 401);
    }

    // Check if user is admin
    if (user.user_metadata?.role !== 'admin') {
      return c.json({ error: "Forbidden - admin role required" }, 403);
    }

    const productData = await c.req.json();
    const { name, price, category, barcode, description, image, stock } = productData;

    if (!name || price === undefined) {
      return c.json({ error: "Name and price are required" }, 400);
    }

    const id = crypto.randomUUID();
    const product = {
      id,
      name,
      price: parseFloat(price),
      category: category || 'uncategorized',
      barcode: barcode || '',
      description: description || '',
      image: image || '',
      stock: stock !== undefined ? parseInt(stock) : 100,
      available: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await kv.set(`product:${id}`, product);
    return c.json({ product });
  } catch (error) {
    console.log(`Error creating product: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// Update product (admin only)
app.put("/make-server-81f0b18a/products/:id", async (c) => {
  try {
    const accessToken = c.req.header('Authorization')?.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    
    if (!user || authError) {
      return c.json({ error: "Unauthorized - admin access required" }, 401);
    }

    // Check if user is admin
    if (user.user_metadata?.role !== 'admin') {
      return c.json({ error: "Forbidden - admin role required" }, 403);
    }

    const id = c.req.param('id');
    const existingProduct = await kv.get(`product:${id}`);
    
    if (!existingProduct) {
      return c.json({ error: "Product not found" }, 404);
    }

    const updates = await c.req.json();
    const updatedProduct = {
      ...existingProduct,
      ...updates,
      id, // Prevent ID change
      updatedAt: new Date().toISOString()
    };

    await kv.set(`product:${id}`, updatedProduct);
    return c.json({ product: updatedProduct });
  } catch (error) {
    console.log(`Error updating product: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// Delete product (admin only)
app.delete("/make-server-81f0b18a/products/:id", async (c) => {
  try {
    const accessToken = c.req.header('Authorization')?.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    
    if (!user || authError) {
      return c.json({ error: "Unauthorized - admin access required" }, 401);
    }

    // Check if user is admin
    if (user.user_metadata?.role !== 'admin') {
      return c.json({ error: "Forbidden - admin role required" }, 403);
    }

    const id = c.req.param('id');
    const product = await kv.get(`product:${id}`);
    
    if (!product) {
      return c.json({ error: "Product not found" }, 404);
    }

    await kv.del(`product:${id}`);
    return c.json({ message: "Product deleted successfully" });
  } catch (error) {
    console.log(`Error deleting product: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// ============ CATEGORY ROUTES ============

// Get all categories
app.get("/make-server-81f0b18a/categories", async (c) => {
  try {
    const categories = await kv.getByPrefix('category:');
    return c.json({ categories });
  } catch (error) {
    console.log(`Error fetching categories: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// Create category (admin only)
app.post("/make-server-81f0b18a/categories", async (c) => {
  try {
    const accessToken = c.req.header('Authorization')?.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    
    if (!user || authError) {
      return c.json({ error: "Unauthorized - admin access required" }, 401);
    }

    if (user.user_metadata?.role !== 'admin') {
      return c.json({ error: "Forbidden - admin role required" }, 403);
    }

    const { name, color } = await c.req.json();

    if (!name) {
      return c.json({ error: "Category name is required" }, 400);
    }

    const id = crypto.randomUUID();
    const category = {
      id,
      name,
      color: color || '#3b82f6',
      createdAt: new Date().toISOString()
    };

    await kv.set(`category:${id}`, category);
    return c.json({ category });
  } catch (error) {
    console.log(`Error creating category: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// Delete category (admin only)
app.delete("/make-server-81f0b18a/categories/:id", async (c) => {
  try {
    const accessToken = c.req.header('Authorization')?.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    
    if (!user || authError) {
      return c.json({ error: "Unauthorized - admin access required" }, 401);
    }

    if (user.user_metadata?.role !== 'admin') {
      return c.json({ error: "Forbidden - admin role required" }, 403);
    }

    const id = c.req.param('id');
    await kv.del(`category:${id}`);
    return c.json({ message: "Category deleted successfully" });
  } catch (error) {
    console.log(`Error deleting category: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// ============ SETTINGS ROUTES ============

// Get POS settings
app.get("/make-server-81f0b18a/settings", async (c) => {
  try {
    const settings = await kv.get('pos:settings');
    return c.json({ settings: settings || { mode: 'table', currency: '$' } });
  } catch (error) {
    console.log(`Error fetching settings: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// Update POS settings (admin only)
app.put("/make-server-81f0b18a/settings", async (c) => {
  try {
    const accessToken = c.req.header('Authorization')?.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    
    if (!user || authError) {
      return c.json({ error: "Unauthorized - admin access required" }, 401);
    }

    if (user.user_metadata?.role !== 'admin') {
      return c.json({ error: "Forbidden - admin role required" }, 403);
    }

    const settings = await c.req.json();
    await kv.set('pos:settings', settings);
    return c.json({ settings });
  } catch (error) {
    console.log(`Error updating settings: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// ============ ORDER/TICKET ROUTES ============

// Get all active orders
app.get("/make-server-81f0b18a/orders", async (c) => {
  try {
    const orders = await kv.getByPrefix('order:');
    // Filter only active orders
    const activeOrders = orders.filter((order: any) => order.status !== 'completed' && order.status !== 'cancelled');
    return c.json({ orders: activeOrders });
  } catch (error) {
    console.log(`Error fetching orders: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// Get single order
app.get("/make-server-81f0b18a/orders/:id", async (c) => {
  try {
    const id = c.req.param('id');
    const order = await kv.get(`order:${id}`);
    
    if (!order) {
      return c.json({ error: "Order not found" }, 404);
    }
    
    return c.json({ order });
  } catch (error) {
    console.log(`Error fetching order: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// Create order
app.post("/make-server-81f0b18a/orders", async (c) => {
  try {
    const accessToken = c.req.header('Authorization')?.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    
    if (!user || authError) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const orderData = await c.req.json();
    const { items, tableNumber, orderType } = orderData;

    if (!items || items.length === 0) {
      return c.json({ error: "Items are required" }, 400);
    }

    const id = crypto.randomUUID();
    const order = {
      id,
      items,
      tableNumber: tableNumber || null,
      orderType: orderType || 'table', // 'table' or 'instant'
      status: 'active',
      total: items.reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0),
      createdBy: user.id,
      createdByName: user.user_metadata?.name || user.email,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await kv.set(`order:${id}`, order);
    return c.json({ order });
  } catch (error) {
    console.log(`Error creating order: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// Update order
app.put("/make-server-81f0b18a/orders/:id", async (c) => {
  try {
    const accessToken = c.req.header('Authorization')?.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    
    if (!user || authError) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const id = c.req.param('id');
    const existingOrder = await kv.get(`order:${id}`);
    
    if (!existingOrder) {
      return c.json({ error: "Order not found" }, 404);
    }

    const updates = await c.req.json();
    
    // Recalculate total if items changed
    let total = existingOrder.total;
    if (updates.items) {
      total = updates.items.reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0);
    }

    const updatedOrder = {
      ...existingOrder,
      ...updates,
      id,
      total,
      updatedAt: new Date().toISOString()
    };

    await kv.set(`order:${id}`, updatedOrder);
    return c.json({ order: updatedOrder });
  } catch (error) {
    console.log(`Error updating order: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// Complete order (payment)
app.post("/make-server-81f0b18a/orders/:id/complete", async (c) => {
  try {
    const accessToken = c.req.header('Authorization')?.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    
    if (!user || authError) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const id = c.req.param('id');
    const order = await kv.get(`order:${id}`);
    
    if (!order) {
      return c.json({ error: "Order not found" }, 404);
    }

    const { paymentMethod } = await c.req.json();

    const completedOrder = {
      ...order,
      status: 'completed',
      paymentMethod: paymentMethod || 'cash',
      completedAt: new Date().toISOString(),
      completedBy: user.id
    };

    await kv.set(`order:${id}`, completedOrder);
    
    // Update product stock
    for (const item of order.items) {
      const product = await kv.get(`product:${item.productId}`);
      if (product && product.stock !== undefined) {
        product.stock = Math.max(0, product.stock - item.quantity);
        product.available = product.stock > 0;
        await kv.set(`product:${item.productId}`, product);
      }
    }

    return c.json({ order: completedOrder });
  } catch (error) {
    console.log(`Error completing order: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

// Delete/Cancel order
app.delete("/make-server-81f0b18a/orders/:id", async (c) => {
  try {
    const accessToken = c.req.header('Authorization')?.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    
    if (!user || authError) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const id = c.req.param('id');
    const order = await kv.get(`order:${id}`);
    
    if (!order) {
      return c.json({ error: "Order not found" }, 404);
    }

    // Mark as cancelled instead of deleting
    const cancelledOrder = {
      ...order,
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancelledBy: user.id
    };

    await kv.set(`order:${id}`, cancelledOrder);
    return c.json({ message: "Order cancelled successfully" });
  } catch (error) {
    console.log(`Error cancelling order: ${error}`);
    return c.json({ error: String(error) }, 500);
  }
});

Deno.serve(app.fetch);
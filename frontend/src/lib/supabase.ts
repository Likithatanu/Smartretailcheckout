import { createClient } from '@supabase/supabase-js';
import type { Product, Profile, RegisterSession, PublicReceipt, CartItem, Order, InventoryMovement, RegisterRpcResult } from '../types/database';

export type { RegisterRpcResult };

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing Supabase configuration in environment variables.');
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

/**
 * Register a new retailer user through Supabase Auth.
 * Credentials are sent directly to Supabase Auth; plaintext passwords are never stored.
 * Sets full_name in Auth user_metadata.
 * Supplies dynamic application origin for email confirmation redirect.
 */
export async function registerRetailer({
  email,
  password,
  fullName,
  storeMetadata,
}: {
  email: string;
  password: string;
  fullName: string;
  storeMetadata?: {
    store_name?: string;
    store_code?: string;
    store_address?: string;
    default_tax_rate?: number;
  };
}) {
  const cleanEmail = email.trim().toLowerCase();
  const cleanFullName = fullName.trim();

  // Direct confirmation callback to the active application origin
  const redirectUrl = typeof window !== 'undefined' ? `${window.location.origin}/` : undefined;

  const { data, error } = await supabase.auth.signUp({
    email: cleanEmail,
    password,
    options: {
      data: {
        full_name: cleanFullName,
        ...(storeMetadata || {}),
      },
      emailRedirectTo: redirectUrl,
    },
  });

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Register a new store and assign the authenticated caller as its store manager.
 * Invokes the secure backend RPC `register_store_and_manager`.
 * Role is assigned internally on the server ('store_manager'); clients cannot request or escalate roles.
 * Idempotent: Returns the existing profile if already registered.
 */
export async function registerStoreAndManager({
  storeName,
  storeCode,
  defaultTaxRate = 0.00,
  storeAddress,
  fullName,
}: {
  storeName?: string;
  storeCode?: string;
  defaultTaxRate?: number;
  storeAddress?: string;
  fullName?: string;
}): Promise<RegisterRpcResult> {
  const { data, error } = await supabase.rpc('register_store_and_manager', {
    p_store_name: storeName ? storeName.trim() : null,
    p_store_code: storeCode ? storeCode.trim().toUpperCase() : null,
    p_default_tax_rate: defaultTaxRate !== undefined ? defaultTaxRate : null,
    p_store_address: storeAddress?.trim() || null,
    p_full_name: fullName?.trim() || null,
  });

  if (error) {
    console.error('Error in registerStoreAndManager RPC:', error);
    throw error;
  }

  return data as RegisterRpcResult;
}

/**
 * Resend the signup confirmation email to an unconfirmed retailer user.
 * Normalizes email and enforces privacy by strictly suppressing enumeration leaks.
 * Preserves rate-limit and network error guidance.
 */
export async function resendConfirmationEmail(email: string): Promise<{ success: boolean; message: string }> {
  const cleanEmail = email.trim().toLowerCase();
  const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  if (!cleanEmail || !emailRegex.test(cleanEmail)) {
    throw new Error('Please enter a valid retailer email address.');
  }

  const redirectUrl = typeof window !== 'undefined' ? `${window.location.origin}/` : undefined;

  const { error } = await supabase.auth.resend({
    type: 'signup',
    email: cleanEmail,
    options: {
      emailRedirectTo: redirectUrl,
    },
  });

  if (error) {
    console.error('Error resending confirmation email:', error);
    const msg = (error.message || '').toLowerCase();
    const status = error.status;

    // Preserve actionable rate-limiting guidance
    if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
      throw new Error('Email rate limit reached. Please wait a few minutes before requesting another confirmation email.');
    }

    // Preserve actionable network / connectivity guidance
    if (msg.includes('failed to fetch') || msg.includes('network') || error.name === 'AuthRetryableFetchError') {
      throw new Error('Network connection error. Please verify your internet connection and try again.');
    }

    // Server-side errors (HTTP 5xx)
    if (status && status >= 500) {
      throw new Error('Authentication service is temporarily unavailable. Please try again shortly.');
    }

    // For all other errors (user not found, already confirmed, or invalid user state),
    // strictly suppress raw GoTrue messages to prevent account enumeration attacks.
    // Return the standard generic message so all responses appear identical to outside observers.
    return {
      success: true,
      message: 'If an unconfirmed account exists with this email address, a fresh verification link has been sent.',
    };
  }

  return {
    success: true,
    message: 'If an unconfirmed account exists with this email address, a fresh verification link has been sent.',
  };
}

/**
 * Sign in a retailer user with email and password through Supabase Auth.
 */
export async function signInRetailer({
  email,
  password,
}: {
  email: string;
  password: string;
}) {
  const cleanEmail = email.trim().toLowerCase();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: cleanEmail,
    password,
  });

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Fetch retailer profile and store metadata for the currently logged-in user.
 */
export async function getCurrentRetailerProfile(): Promise<Profile | null> {
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return null;
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('*, store:stores(*)')
    .eq('id', user.id)
    .single();

  if (error || !data) {
    console.error('Failed to load profile for authenticated user:', error);
    return null;
  }

  return data as Profile;
}

/**
 * Fetch all active products for the authorized store.
 */
export async function getStoreProducts(storeId: string): Promise<Product[]> {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('store_id', storeId)
    .eq('is_active', true)
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching store products:', error);
    throw error;
  }

  return (data || []) as Product[];
}

/**
 * Look up a product by exact barcode match in the authorized store.
 */
export async function getProductByBarcode(storeId: string, barcode: string): Promise<Product | null> {
  const cleanBarcode = barcode.trim();
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('store_id', storeId)
    .eq('barcode', cleanBarcode)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    console.error('Error looking up barcode:', error);
    throw error;
  }

  return (data || null) as Product | null;
}

/**
 * Look up a loose grain product by model_class in the authorized store.
 */
export async function getProductByModelClass(storeId: string, modelClass: string): Promise<Product | null> {
  const cleanClass = modelClass.trim().toLowerCase();
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('store_id', storeId)
    .eq('product_type', 'loose')
    .eq('model_class', cleanClass)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    console.error('Error looking up product by model class:', error);
    throw error;
  }

  return (data || null) as Product | null;
}

/**
 * Get active register session for the current store and retailer.
 */
export async function getActiveRegisterSession(storeId: string, retailerId: string): Promise<RegisterSession | null> {
  const { data, error } = await supabase
    .from('register_sessions')
    .select('*')
    .eq('store_id', storeId)
    .eq('retailer_id', retailerId)
    .eq('status', 'ACTIVE')
    .gt('expires_at', new Date().toISOString())
    .order('opened_at', { ascending: false })
    .maybeSingle();

  if (error) {
    console.error('Error loading active register session:', error);
    return null;
  }

  return (data || null) as RegisterSession | null;
}

/**
 * Open a new register session via database RPC.
 */
export async function openRegisterSession(registerName: string): Promise<RegisterSession> {
  const { data, error } = await supabase.rpc('open_register_session', {
    p_register_name: registerName,
  });

  if (error) {
    console.error('Error opening register session:', error);
    throw error;
  }

  const sessionId = data?.register_session_id || data?.id;
  if (!sessionId) {
    throw new Error('RPC open_register_session did not return a session ID.');
  }

  // Retrieve complete database row to ensure store_id, retailer_id, and opened_at are populated
  const { data: sessionRow, error: fetchErr } = await supabase
    .from('register_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();

  if (fetchErr || !sessionRow) {
    return {
      id: sessionId,
      store_id: '',
      retailer_id: '',
      register_name: data.register_name || registerName,
      status: 'ACTIVE',
      opened_at: new Date().toISOString(),
      expires_at: data.expires_at,
      closed_at: null,
    };
  }

  return sessionRow as RegisterSession;
}

/**
 * Close an active register session via database RPC.
 */
export async function closeRegisterSession(sessionId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('close_register_session', {
    p_register_session_id: sessionId,
  });

  if (error) {
    console.error('Error closing register session:', error);
    throw error;
  }

  return data.success === true;
}

/**
 * Add a new product to store catalog.
 * Note: stock_quantity is omitted on INSERT because it defaults to 0.000 and is guarded by DB trigger.
 * Stock adjustments must be performed through the adjust_inventory_stock RPC.
 */
export async function createProduct(
  product: Omit<Product, 'id' | 'created_at' | 'updated_at' | 'stock_quantity'> & { stock_quantity?: number }
): Promise<Product> {
  // Strip stock_quantity so PostgreSQL column-level INSERT privileges are respected
  const { stock_quantity, ...insertPayload } = product;

  const { data, error } = await supabase
    .from('products')
    .insert([insertPayload])
    .select('*')
    .single();

  if (error) {
    console.error('Error creating product:', error);
    throw error;
  }

  return data as Product;
}

/**
 * Update product details.
 */
export async function updateProduct(
  productId: string,
  updates: Partial<Pick<Product, 'name' | 'price_per_unit' | 'tax_rate_percent' | 'min_stock_threshold' | 'barcode' | 'model_class' | 'is_active'>>
): Promise<Product> {
  const { data, error } = await supabase
    .from('products')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', productId)
    .select('*')
    .single();

  if (error) {
    console.error('Error updating product:', error);
    throw error;
  }

  return data as Product;
}

/**
 * Adjust product stock via database RPC.
 */
export async function adjustInventoryStock(
  productId: string,
  quantityDelta: number,
  movementType: 'RESTOCK' | 'CORRECTION' | 'DAMAGE',
  reason: string
) {
  const { data, error } = await supabase.rpc('adjust_inventory_stock', {
    p_product_id: productId,
    p_quantity_delta: quantityDelta,
    p_movement_type: movementType,
    p_reason: reason,
  });

  if (error) {
    console.error('Error adjusting inventory stock:', error);
    throw error;
  }

  return data;
}

/**
 * Execute atomic checkout via database RPC.
 */
export async function processCheckout(
  items: CartItem[],
  registerSessionId: string,
  idempotencyKey: string
): Promise<{
  success: boolean;
  order_id: string;
  order_number: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  receipt_token: string;
  is_duplicate?: boolean;
}> {
  // Consolidate any duplicate product entries by summing their quantity/weight
  // (Database RPC strictly rejects duplicate product_id entries in p_items)
  const consolidatedMap = new Map<string, number>();
  for (const item of items) {
    const prev = consolidatedMap.get(item.product.id) || 0;
    consolidatedMap.set(item.product.id, Number((prev + item.quantity_or_weight).toFixed(3)));
  }

  const payloadItems = Array.from(consolidatedMap.entries()).map(([productId, qty]) => ({
    product_id: productId,
    quantity_or_weight: qty,
  }));

  const { data, error } = await supabase.rpc('process_checkout', {
    p_items: payloadItems,
    p_register_session_id: registerSessionId,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    console.error('Error processing checkout RPC:', error);
    throw error;
  }

  return data;
}

/**
 * Retrieve a public digital receipt by its unguessable UUID token.
 * Does not require customer login or credentials.
 */
export async function getReceiptByToken(receiptToken: string): Promise<PublicReceipt> {
  const { data, error } = await supabase.rpc('get_receipt_by_token', {
    p_token: receiptToken,
  });

  if (error) {
    console.error('Error retrieving public receipt:', error);
    throw error;
  }

  return data as PublicReceipt;
}

/**
 * Retrieve recent real orders for the authorized store.
 */
export async function getStoreOrders(storeId: string): Promise<Order[]> {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('Error retrieving store orders:', error);
    throw error;
  }

  return (data || []) as Order[];
}

/**
 * Retrieve real inventory movement history for the authorized store.
 */
export async function getStoreInventoryMovements(storeId: string): Promise<InventoryMovement[]> {
  const { data, error } = await supabase
    .from('inventory_movements')
    .select('*, product:products(name, barcode, unit)')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('Error retrieving inventory movements:', error);
    throw error;
  }

  return (data || []) as InventoryMovement[];
}

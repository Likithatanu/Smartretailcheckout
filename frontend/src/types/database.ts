export type RetailerRole = 'retailer' | 'store_manager' | 'admin';
export type ProductType = 'loose' | 'packaged';
export type OrderStatus = 'checkout_completed';
export type MovementType = 'SALE' | 'RESTOCK' | 'DAMAGE' | 'CORRECTION';
export type RegisterStatus = 'ACTIVE' | 'CLOSED';

export interface Store {
  id: string;
  name: string;
  store_code: string;
  address: string | null;
  default_tax_rate: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Profile {
  id: string;
  store_id: string;
  role: RetailerRole;
  full_name: string;
  email: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  store?: Store;
}

export interface RegisterRpcResult {
  success: boolean;
  already_registered: boolean;
  is_active: boolean;
  message: string;
  profile: {
    id: string;
    store_id: string;
    role: RetailerRole;
    full_name: string;
    email: string;
    store_name: string;
    store_code: string;
    default_tax_rate: number;
  };
}

export interface RegisterSession {
  id: string;
  store_id: string;
  retailer_id: string;
  register_name: string;
  status: RegisterStatus;
  opened_at: string;
  expires_at: string;
  closed_at: string | null;
}

export interface Product {
  id: string;
  store_id: string;
  name: string;
  product_type: ProductType;
  model_class: string | null;
  barcode: string | null;
  unit: string;
  price_per_unit: number;
  tax_rate_percent: number;
  stock_quantity: number;
  min_stock_threshold: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Order {
  id: string;
  store_id: string;
  order_number: string;
  retailer_id: string;
  register_session_id: string;
  idempotency_key: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  status: OrderStatus;
  receipt_token: string;
  payload_hash: string;
  created_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  store_id: string;
  product_name_snapshot: string;
  product_type_snapshot: ProductType;
  unit_snapshot: string;
  unit_price_snapshot: number;
  base_subtotal_snapshot: number;
  tax_rate_snapshot: number;
  tax_amount_snapshot: number;
  quantity_or_weight: number;
  item_total: number;
  created_at: string;
}

export interface InventoryMovement {
  id: string;
  store_id: string;
  product_id: string;
  movement_type: MovementType;
  quantity_delta: number;
  resulting_stock: number;
  order_id: string | null;
  authorized_by: string | null;
  reason: string;
  created_at: string;
  product?: {
    name: string;
    barcode: string | null;
    unit: string;
  };
}

export interface PublicReceiptItem {
  name: string;
  type: ProductType;
  unit: string;
  unit_price: number;
  base_subtotal: number;
  tax_rate: number;
  tax_amount: number;
  quantity_or_weight: number;
  item_total: number;
}

export interface PublicReceipt {
  store_name: string;
  store_address: string | null;
  order_number: string;
  date: string;
  created_at?: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  status: string;
  cancellation: {
    cancellation_number: string;
    cancelled_at: string;
    reason: string;
  } | null;
  items: PublicReceiptItem[];
}

export interface CartItem {
  product: Product;
  quantity_or_weight: number;
  base_subtotal: number;
  tax_amount: number;
  item_total: number;
  detection_source: 'ai_camera' | 'barcode_scanner' | 'manual';
  confidence?: number;
  weight_grams?: number;
}

export interface ScaleStatus {
  connected: boolean;
  weight_grams: number | null;
  unit: string;
  status: 'connected' | 'disconnected' | 'awaiting_data' | 'sensor_error';
  port: string;
  detail?: string | null;
}

export interface VisionPrediction {
  predicted_class: 'chana_dal' | 'masur_dal' | 'rice';
  confidence: number;
  probabilities: Record<string, number>;
  is_confident: boolean;
  is_ood?: boolean;
  rejection_reason?: string | null;
  model_version: string;
  confidence_threshold: number;
  timestamp: string;
  roi?: {
    enabled: boolean;
    x_min: number;
    y_min: number;
    x_max: number;
    y_max: number;
  } | null;
}

export interface BridgeHealth {
  status: 'ok' | 'degraded';
  api_running: boolean;
  model_loaded: boolean;
  model_name?: string | null;
  classes?: string[] | null;
  serial_connected: boolean;
  serial_port: string;
  camera_available: boolean;
  active_model_version: string;
  available_model_versions: string[];
}

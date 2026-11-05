-- =============================================================================
-- AI SMART RETAIL CHECKOUT — PHASE 1: PRODUCTION SCHEMA, POLICIES & FUNCTIONS
-- HARDENED & IDEMPOTENT FIRST INSTALLATION
-- =============================================================================

-- Ensure unqualified references safely resolve to public
SET search_path = public, extensions;

BEGIN;


-- 1. SECURITY: REVOKE SCHEMA CREATION FROM UNTRUSTED ROLES
REVOKE CREATE ON SCHEMA public FROM public, anon, authenticated;

-- 2. EXTENSIONS & PREREQUISITES
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;

DO $$
DECLARE
    v_ext_schema  TEXT;
    v_test_digest BYTEA;
    v_test_bytes  BYTEA;
BEGIN
    SELECT n.nspname INTO v_ext_schema
    FROM pg_extension e
    JOIN pg_namespace n ON e.extnamespace = n.oid
    WHERE e.extname = 'pgcrypto';

    IF v_ext_schema IS NULL THEN
        RAISE EXCEPTION 'PREREQUISITE FAILURE: pgcrypto extension is not installed.';
    END IF;

    BEGIN
        SET LOCAL search_path = public, extensions, pg_temp;
        v_test_digest := digest('retail_precheck'::text, 'sha256');
        v_test_bytes  := gen_random_bytes(16);
    EXCEPTION WHEN undefined_function THEN
        RAISE EXCEPTION 'PREREQUISITE FAILURE: pgcrypto functions failed to resolve under search_path. Schema: "%"', v_ext_schema;
    END;

    IF v_test_digest IS NULL OR length(v_test_bytes) != 16 THEN
        RAISE EXCEPTION 'PREREQUISITE FAILURE: Cryptographic self-test produced invalid output.';
    END IF;
END $$;

REVOKE CREATE ON SCHEMA extensions FROM public, anon, authenticated;

-- 3. CUSTOM ENUMS
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'retailer_role_enum') THEN
        CREATE TYPE public.retailer_role_enum AS ENUM ('retailer', 'store_manager', 'admin');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'product_type_enum') THEN
        CREATE TYPE public.product_type_enum AS ENUM ('loose', 'packaged');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status_enum') THEN
        CREATE TYPE public.order_status_enum AS ENUM ('checkout_completed');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'movement_type_enum') THEN
        CREATE TYPE public.movement_type_enum AS ENUM ('SALE', 'RESTOCK', 'DAMAGE', 'CORRECTION');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'register_status_enum') THEN
        CREATE TYPE public.register_status_enum AS ENUM ('ACTIVE', 'CLOSED');
    END IF;
END $$;
-- 4. SEQUENCES (Internal, No Direct Client Access)
CREATE SEQUENCE IF NOT EXISTS public.order_number_seq START WITH 1001 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.cancellation_number_seq START WITH 1001 INCREMENT BY 1;

-- 5. STORES TABLE
CREATE TABLE IF NOT EXISTS public.stores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    store_code TEXT NOT NULL UNIQUE,
    address TEXT,
    default_tax_rate NUMERIC(5, 2) NOT NULL DEFAULT 0.00 CHECK (default_tax_rate >= 0.00 AND default_tax_rate <= 100.00),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. PROFILES TABLE (Bound to Supabase Auth)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY,
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
    role retailer_role_enum NOT NULL DEFAULT 'retailer',
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_profiles_auth_user FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- 7. REGISTER SESSIONS TABLE
CREATE TABLE IF NOT EXISTS public.register_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
    retailer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    register_name TEXT NOT NULL,
    status register_status_enum NOT NULL DEFAULT 'ACTIVE',
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '16 hours',
    closed_at TIMESTAMPTZ,

    CONSTRAINT uq_register_session_store UNIQUE (id, store_id)
);

-- 8. PRODUCTS TABLE
CREATE TABLE IF NOT EXISTS public.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    product_type product_type_enum NOT NULL,
    model_class TEXT,
    barcode TEXT,
    unit TEXT NOT NULL,
    price_per_unit NUMERIC(12, 2) NOT NULL CHECK (price_per_unit >= 0.00 AND price_per_unit <= 1000000.00),
    tax_rate_percent NUMERIC(5, 2) NOT NULL DEFAULT 0.00 CHECK (tax_rate_percent >= 0.00 AND tax_rate_percent <= 100.00),
    stock_quantity NUMERIC(10, 3) NOT NULL DEFAULT 0.000 CHECK (stock_quantity >= 0.000 AND stock_quantity <= 9999999.999),
    min_stock_threshold NUMERIC(10, 3) NOT NULL DEFAULT 5.000 CHECK (min_stock_threshold >= 0.000),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_product_store UNIQUE (id, store_id),
    CONSTRAINT uq_store_barcode UNIQUE (store_id, barcode),
    CONSTRAINT uq_store_model_class UNIQUE (store_id, model_class),
    CONSTRAINT chk_product_type_integrity CHECK (
        (product_type = 'loose' AND model_class IS NOT NULL AND barcode IS NULL AND unit = 'kg') OR
        (product_type = 'packaged' AND barcode IS NOT NULL AND model_class IS NULL AND unit IN ('piece', 'pack'))
    )
);

-- 9. ORDERS TABLE (Immutable Receipt Headers)
CREATE TABLE IF NOT EXISTS public.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
    order_number TEXT NOT NULL,
    retailer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    register_session_id UUID NOT NULL,
    idempotency_key UUID NOT NULL,
    payload_hash TEXT NOT NULL,
    subtotal NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0.00),
    tax_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (tax_amount >= 0.00),
    total_amount NUMERIC(12, 2) NOT NULL CHECK (total_amount >= 0.00),
    status order_status_enum NOT NULL DEFAULT 'checkout_completed',
    receipt_token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_order_store UNIQUE (id, store_id),
    CONSTRAINT uq_store_order_number UNIQUE (store_id, order_number),
    CONSTRAINT uq_store_idempotency UNIQUE (store_id, idempotency_key),
    CONSTRAINT chk_order_total_match CHECK (total_amount = subtotal + tax_amount),
    CONSTRAINT fk_orders_register_session FOREIGN KEY (register_session_id, store_id) REFERENCES public.register_sessions(id, store_id) ON DELETE RESTRICT
);

-- 10. ORDER ITEMS TABLE (Immutable Line Item Snapshots)
CREATE TABLE IF NOT EXISTS public.order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    product_id UUID NOT NULL,
    store_id UUID NOT NULL,
    product_name_snapshot TEXT NOT NULL,
    product_type_snapshot product_type_enum NOT NULL,
    unit_snapshot TEXT NOT NULL,
    unit_price_snapshot NUMERIC(12, 2) NOT NULL CHECK (unit_price_snapshot >= 0.00),
    base_subtotal_snapshot NUMERIC(12, 2) NOT NULL CHECK (base_subtotal_snapshot >= 0.00),
    tax_rate_snapshot NUMERIC(5, 2) NOT NULL CHECK (tax_rate_snapshot >= 0.00 AND tax_rate_snapshot <= 100.00),
    tax_amount_snapshot NUMERIC(12, 2) NOT NULL CHECK (tax_amount_snapshot >= 0.00),
    quantity_or_weight NUMERIC(10, 3) NOT NULL CHECK (quantity_or_weight > 0.000),
    item_total NUMERIC(12, 2) NOT NULL CHECK (item_total >= 0.00),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_item_total_match CHECK (item_total = base_subtotal_snapshot + tax_amount_snapshot),
    CONSTRAINT fk_order_items_order FOREIGN KEY (order_id, store_id) REFERENCES public.orders(id, store_id) ON DELETE RESTRICT,
    CONSTRAINT fk_order_items_product FOREIGN KEY (product_id, store_id) REFERENCES public.products(id, store_id) ON DELETE RESTRICT
);

-- 11. ORDER CANCELLATIONS TABLE (Append-Only Cancellation Ledger)
CREATE TABLE IF NOT EXISTS public.order_cancellations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL UNIQUE,
    store_id UUID NOT NULL,
    cancelled_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    cancellation_number TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_order_cancellations_order FOREIGN KEY (order_id, store_id) REFERENCES public.orders(id, store_id) ON DELETE RESTRICT,
    CONSTRAINT fk_order_cancellations_store FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT
);

-- 12. INVENTORY MOVEMENTS TABLE (Strictly Append-Only Audit Ledger)
CREATE TABLE IF NOT EXISTS public.inventory_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL,
    product_id UUID NOT NULL,
    movement_type movement_type_enum NOT NULL,
    quantity_delta NUMERIC(10, 3) NOT NULL,
    resulting_stock NUMERIC(10, 3) NOT NULL CHECK (resulting_stock >= 0.000 AND resulting_stock <= 9999999.999),
    order_id UUID,
    authorized_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_inv_mov_product FOREIGN KEY (product_id, store_id) REFERENCES public.products(id, store_id) ON DELETE RESTRICT,
    CONSTRAINT fk_inv_mov_order FOREIGN KEY (order_id, store_id) REFERENCES public.orders(id, store_id) ON DELETE RESTRICT,
    CONSTRAINT chk_quantity_delta_sign CHECK (
        (movement_type = 'RESTOCK' AND quantity_delta > 0.000) OR
        (movement_type = 'DAMAGE' AND quantity_delta < 0.000) OR
        (movement_type = 'SALE' AND quantity_delta < 0.000) OR
        (movement_type = 'CORRECTION' AND quantity_delta != 0.000)
    )
);

-- 13. SCANNER PAIRINGS TABLE
CREATE TABLE IF NOT EXISTS public.scanner_pairings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL,
    register_session_id UUID NOT NULL,
    retailer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    pairing_code TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_consumed BOOLEAN NOT NULL DEFAULT FALSE,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_pairings_session FOREIGN KEY (register_session_id, store_id) REFERENCES public.register_sessions(id, store_id) ON DELETE RESTRICT
);

-- 14. SCANNER SESSIONS TABLE (Active Bearer Tokens)
CREATE TABLE IF NOT EXISTS public.scanner_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL,
    register_session_id UUID NOT NULL,
    pairing_id UUID NOT NULL REFERENCES public.scanner_pairings(id) ON DELETE RESTRICT,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_scanner_sessions_reg FOREIGN KEY (register_session_id, store_id) REFERENCES public.register_sessions(id, store_id) ON DELETE RESTRICT
);

-- 15. PAIRING RATE LIMITS TABLE
CREATE TABLE IF NOT EXISTS public.pairing_rate_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_code TEXT NOT NULL,
    client_identifier TEXT NOT NULL,
    failed_attempts INT NOT NULL DEFAULT 0,
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_rate_limit_client UNIQUE (store_code, client_identifier)
);

-- 16. INDEXES
CREATE INDEX IF NOT EXISTS idx_profiles_store ON public.profiles(store_id);
CREATE INDEX IF NOT EXISTS idx_products_store_active ON public.products(store_id, is_active);
CREATE INDEX IF NOT EXISTS idx_orders_store_created ON public.orders(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_receipt_token ON public.orders(receipt_token);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON public.order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_prod ON public.inventory_movements(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scanner_sessions_hash ON public.scanner_sessions(token_hash) WHERE is_revoked = FALSE;
CREATE INDEX IF NOT EXISTS idx_scanner_pairings_active ON public.scanner_pairings(store_id, pairing_code) WHERE is_active = TRUE AND is_consumed = FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_pairing_code ON public.scanner_pairings (pairing_code) WHERE (is_active = TRUE);

-- =============================================================================
-- IMMUTABILITY & GUARD TRIGGERS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.force_zero_initial_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    NEW.stock_quantity := 0.000;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_force_zero_initial_stock ON public.products;
CREATE TRIGGER trg_force_zero_initial_stock
    BEFORE INSERT ON public.products
    FOR EACH ROW
    EXECUTE FUNCTION force_zero_initial_stock();

CREATE OR REPLACE FUNCTION public.guard_direct_stock_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF current_setting('app.authorized_stock_ctx', true) IS DISTINCT FROM 'valid' THEN
        IF NEW.stock_quantity IS DISTINCT FROM OLD.stock_quantity THEN
            RAISE EXCEPTION 'Direct stock modification blocked. Stock updates must occur via authorized inventory procedures.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_stock_mutation ON public.products;
CREATE TRIGGER trg_guard_stock_mutation
    BEFORE UPDATE ON public.products
    FOR EACH ROW
    EXECUTE FUNCTION guard_direct_stock_mutation();

CREATE OR REPLACE FUNCTION public.prevent_audit_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'Audit ledger tables are immutable. Updates and deletions are prohibited.';
END;
$$;
DROP TRIGGER IF EXISTS trg_prevent_audit_mutation ON public.inventory_movements;
CREATE TRIGGER trg_prevent_audit_mutation
    BEFORE UPDATE OR DELETE ON public.inventory_movements
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_ledger_mutation();

CREATE OR REPLACE FUNCTION public.prevent_order_tampering()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'Orders are immutable. Updates are prohibited on table orders.';
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Orders are immutable. Deletions are prohibited on table orders.';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_prevent_order_tampering ON public.orders;
CREATE TRIGGER trg_prevent_order_tampering
    BEFORE UPDATE OR DELETE ON public.orders
    FOR EACH ROW
    EXECUTE FUNCTION prevent_order_tampering();

DROP TRIGGER IF EXISTS trg_prevent_order_items_mutation ON public.order_items;
CREATE TRIGGER trg_prevent_order_items_mutation
    BEFORE UPDATE OR DELETE ON public.order_items
    FOR EACH ROW
    EXECUTE FUNCTION prevent_order_tampering();

DROP TRIGGER IF EXISTS trg_prevent_cancellation_mutation ON public.order_cancellations;
CREATE TRIGGER trg_prevent_cancellation_mutation
    BEFORE UPDATE OR DELETE ON public.order_cancellations
    FOR EACH ROW
    EXECUTE FUNCTION prevent_order_tampering();

-- =============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =============================================================================

ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.register_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scanner_pairings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scanner_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pairing_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.get_current_retailer_profile()
RETURNS TABLE (profile_id UUID, current_store_id UUID, user_role public.retailer_role_enum)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT p.id, p.store_id, p.role
    FROM public.profiles p
    JOIN public.stores s ON s.id = p.store_id
    WHERE p.id = auth.uid() AND p.is_active = TRUE AND s.is_active = TRUE;
END;
$$;
ALTER FUNCTION public.get_current_retailer_profile() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_current_retailer_profile() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_current_retailer_profile() TO authenticated;

DROP POLICY IF EXISTS "retailers_read_own_store" ON public.stores;
CREATE POLICY "retailers_read_own_store"
    ON public.stores FOR SELECT TO authenticated
    USING (id = (SELECT current_store_id FROM get_current_retailer_profile()));

DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
CREATE POLICY "profiles_select_policy"
    ON public.profiles FOR SELECT TO authenticated
    USING (
        id = auth.uid()
        OR (
            store_id = (SELECT current_store_id FROM get_current_retailer_profile())
            AND (SELECT user_role FROM get_current_retailer_profile()) IN ('store_manager', 'admin')
        )
    );

DROP POLICY IF EXISTS "retailers_read_register_sessions" ON public.register_sessions;
CREATE POLICY "retailers_read_register_sessions"
    ON public.register_sessions FOR SELECT TO authenticated
    USING (store_id = (SELECT current_store_id FROM get_current_retailer_profile()));

DROP POLICY IF EXISTS "retailers_read_store_products" ON public.products;
CREATE POLICY "retailers_read_store_products"
    ON public.products FOR SELECT TO authenticated
    USING (store_id = (SELECT current_store_id FROM get_current_retailer_profile()));

DROP POLICY IF EXISTS "retailers_insert_store_products" ON public.products;
CREATE POLICY "retailers_insert_store_products"
    ON public.products FOR INSERT TO authenticated
    WITH CHECK (
        store_id = (SELECT current_store_id FROM get_current_retailer_profile())
        AND (SELECT user_role FROM get_current_retailer_profile()) IN ('retailer', 'store_manager', 'admin')
    );

DROP POLICY IF EXISTS "retailers_update_store_products" ON public.products;
CREATE POLICY "retailers_update_store_products"
    ON public.products FOR UPDATE TO authenticated
    USING (
        store_id = (SELECT current_store_id FROM get_current_retailer_profile())
        AND (SELECT user_role FROM get_current_retailer_profile()) IN ('retailer', 'store_manager', 'admin')
    )
    WITH CHECK (store_id = (SELECT current_store_id FROM get_current_retailer_profile()));

DROP POLICY IF EXISTS "retailers_read_store_orders" ON public.orders;
CREATE POLICY "retailers_read_store_orders"
    ON public.orders FOR SELECT TO authenticated
    USING (store_id = (SELECT current_store_id FROM get_current_retailer_profile()));

DROP POLICY IF EXISTS "retailers_read_order_items" ON public.order_items;
CREATE POLICY "retailers_read_order_items"
    ON public.order_items FOR SELECT TO authenticated
    USING (store_id = (SELECT current_store_id FROM get_current_retailer_profile()));

DROP POLICY IF EXISTS "retailers_read_order_cancellations" ON public.order_cancellations;
CREATE POLICY "retailers_read_order_cancellations"
    ON public.order_cancellations FOR SELECT TO authenticated
    USING (store_id = (SELECT current_store_id FROM get_current_retailer_profile()));

DROP POLICY IF EXISTS "retailers_read_inventory_movements" ON public.inventory_movements;
CREATE POLICY "retailers_read_inventory_movements"
    ON public.inventory_movements FOR SELECT TO authenticated
    USING (store_id = (SELECT current_store_id FROM get_current_retailer_profile()));

-- =============================================================================
-- PRIVILEGE GRANTS & ACCESS HARDENING
-- =============================================================================

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, public;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, public, authenticated;
REVOKE ALL ON scanner_pairings, scanner_sessions, pairing_rate_limits FROM authenticated;

GRANT SELECT ON stores, profiles, register_sessions, products, orders, order_items, order_cancellations, inventory_movements TO authenticated;
GRANT INSERT (store_id, name, product_type, model_class, barcode, unit, price_per_unit, tax_rate_percent, min_stock_threshold, is_active) ON products TO authenticated;
GRANT UPDATE (name, model_class, barcode, unit, price_per_unit, tax_rate_percent, min_stock_threshold, is_active, updated_at) ON products TO authenticated;

-- =============================================================================
-- SECURE DATABASE FUNCTIONS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.open_register_session(
    p_register_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_profile RECORD;
    v_session_id UUID;
    v_expires_at TIMESTAMPTZ := NOW() + INTERVAL '16 hours';
BEGIN
    SELECT profile_id, current_store_id, user_role INTO v_profile FROM get_current_retailer_profile();
    IF v_profile.profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Active retailer profile required';
    END IF;

    IF TRIM(COALESCE(p_register_name, '')) = '' THEN
        RAISE EXCEPTION 'Register name is mandatory';
    END IF;

    INSERT INTO register_sessions (
        store_id, retailer_id, register_name, status, expires_at
    ) VALUES (
        v_profile.current_store_id, v_profile.profile_id, TRIM(p_register_name), 'ACTIVE', v_expires_at
    ) RETURNING id INTO v_session_id;

    RETURN jsonb_build_object(
        'success', true,
        'register_session_id', v_session_id,
        'register_name', TRIM(p_register_name),
        'expires_at', v_expires_at
    );
END;
$$;
ALTER FUNCTION public.open_register_session(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.open_register_session(TEXT) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.open_register_session(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.close_register_session(
    p_register_session_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_profile RECORD;
    v_session RECORD;
BEGIN
    SELECT profile_id, current_store_id, user_role INTO v_profile FROM get_current_retailer_profile();
    IF v_profile.profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Active retailer profile required';
    END IF;

    SELECT id, retailer_id, status INTO v_session
    FROM register_sessions
    WHERE id = p_register_session_id AND store_id = v_profile.current_store_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Register session % not found in current store', p_register_session_id;
    END IF;

    IF v_session.retailer_id != v_profile.profile_id AND v_profile.user_role NOT IN ('store_manager', 'admin') THEN
        RAISE EXCEPTION 'Unauthorized: You can only close your own register session unless you are a manager';
    END IF;

    UPDATE register_sessions
    SET status = 'CLOSED', closed_at = NOW()
    WHERE id = p_register_session_id;

    UPDATE scanner_pairings
    SET is_active = FALSE
    WHERE register_session_id = p_register_session_id;

    UPDATE scanner_sessions
    SET is_revoked = TRUE
    WHERE register_session_id = p_register_session_id;

    RETURN jsonb_build_object('success', true, 'closed_session_id', p_register_session_id);
END;
$$;
ALTER FUNCTION public.close_register_session(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.close_register_session(UUID) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.close_register_session(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.adjust_inventory_stock(
    p_product_id UUID,
    p_quantity_delta NUMERIC,
    p_movement_type movement_type_enum,
    p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_profile RECORD;
    v_product RECORD;
    v_new_stock NUMERIC(10, 3);
BEGIN
    SELECT profile_id, current_store_id, user_role INTO v_profile FROM get_current_retailer_profile();
    IF v_profile.profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Active retailer profile required';
    END IF;

    IF p_movement_type IN ('RESTOCK', 'CORRECTION') AND v_profile.user_role NOT IN ('store_manager', 'admin') THEN
        RAISE EXCEPTION 'Unauthorized: Only store managers or administrators can perform restocks or corrections';
    END IF;

    IF p_movement_type = 'SALE' THEN
        RAISE EXCEPTION 'Invalid operation: SALE movements can only be created via process_checkout';
    ELSIF p_movement_type = 'RESTOCK' AND p_quantity_delta <= 0.000 THEN
        RAISE EXCEPTION 'Invalid RESTOCK: Quantity delta must be strictly positive';
    ELSIF p_movement_type = 'DAMAGE' AND p_quantity_delta >= 0.000 THEN
        RAISE EXCEPTION 'Invalid DAMAGE: Quantity delta must be strictly negative';
    ELSIF p_movement_type = 'CORRECTION' AND p_quantity_delta = 0.000 THEN
        RAISE EXCEPTION 'Invalid CORRECTION: Quantity delta cannot be zero';
    END IF;

    IF TRIM(COALESCE(p_reason, '')) = '' THEN
        RAISE EXCEPTION 'A valid adjustment reason is mandatory';
    END IF;

    SELECT id, name, unit, stock_quantity, store_id
    INTO v_product
    FROM products
    WHERE id = p_product_id AND store_id = v_profile.current_store_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Product % not found in current store', p_product_id;
    END IF;

    v_new_stock := v_product.stock_quantity + p_quantity_delta;
    IF v_new_stock < 0.000 THEN
        RAISE EXCEPTION 'Adjustment rejected: Resulting stock cannot be negative (Current: %, Delta: %)',
            v_product.stock_quantity, p_quantity_delta;
    END IF;

    IF v_new_stock > 9999999.999 THEN
        RAISE EXCEPTION 'Adjustment rejected: Resulting stock exceeds maximum allowed limit (9,999,999.999)';
    END IF;

    PERFORM set_config('app.authorized_stock_ctx', 'valid', true);

    UPDATE products
    SET stock_quantity = v_new_stock, updated_at = NOW()
    WHERE id = v_product.id;

    INSERT INTO inventory_movements (
        store_id, product_id, movement_type, quantity_delta, resulting_stock, authorized_by, reason
    ) VALUES (
        v_profile.current_store_id, v_product.id, p_movement_type, p_quantity_delta, v_new_stock, v_profile.profile_id, p_reason
    );

    RETURN jsonb_build_object(
        'success', true,
        'product_id', v_product.id,
        'previous_stock', v_product.stock_quantity,
        'quantity_delta', p_quantity_delta,
        'resulting_stock', v_new_stock,
        'unit', v_product.unit
    );
END;
$$;
ALTER FUNCTION public.adjust_inventory_stock(UUID, NUMERIC, movement_type_enum, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.adjust_inventory_stock(UUID, NUMERIC, movement_type_enum, TEXT) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.adjust_inventory_stock(UUID, NUMERIC, movement_type_enum, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.process_checkout(
    p_items JSONB,
    p_register_session_id UUID,
    p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_profile RECORD;
    v_session RECORD;
    v_existing_order RECORD;
    v_lock_key BIGINT;
    v_canonical_json JSONB;
    v_payload_hash TEXT;
    v_order_id UUID;
    v_order_number TEXT;
    v_receipt_token UUID := gen_random_uuid();
    v_item RECORD;
    v_db_product RECORD;
    v_item_count INT;
    v_distinct_count INT;
    v_calc_subtotal NUMERIC(12, 2) := 0.00;
    v_calc_tax_total NUMERIC(12, 2) := 0.00;
    v_calc_grand_total NUMERIC(12, 2) := 0.00;
    v_elem JSONB;
    v_pid_text TEXT;
    v_raw_qty NUMERIC;
    v_qty_or_weight NUMERIC(10, 3);
    v_line_base NUMERIC(12, 2);
    v_line_tax NUMERIC(12, 2);
    v_line_total NUMERIC(12, 2);

    v_prep_pids UUID[] := '{}';
    v_prep_qtys NUMERIC(10, 3)[] := '{}';
    v_prep_names TEXT[] := '{}';
    v_prep_types product_type_enum[] := '{}';
    v_prep_units TEXT[] := '{}';
    v_prep_prices NUMERIC(12, 2)[] := '{}';
    v_prep_bases NUMERIC(12, 2)[] := '{}';
    v_prep_tax_rates NUMERIC(5, 2)[] := '{}';
    v_prep_tax_amounts NUMERIC(12, 2)[] := '{}';
    v_prep_totals NUMERIC(12, 2)[] := '{}';
    v_prep_new_stocks NUMERIC(10, 3)[] := '{}';
    v_idx INT;
BEGIN
    SELECT profile_id, current_store_id, user_role INTO v_profile FROM get_current_retailer_profile();
    IF v_profile.profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Active retailer profile required';
    END IF;

    IF p_idempotency_key IS NULL THEN
        RAISE EXCEPTION 'Idempotency key is mandatory for checkout submission';
    END IF;

    SELECT id, retailer_id, status, expires_at INTO v_session
    FROM register_sessions
    WHERE id = p_register_session_id AND store_id = v_profile.current_store_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Register session not found in current store';
    END IF;

    IF v_session.status != 'ACTIVE' OR v_session.expires_at <= NOW() THEN
        RAISE EXCEPTION 'Register session is closed or expired';
    END IF;

    IF v_session.retailer_id != v_profile.profile_id AND v_profile.user_role NOT IN ('store_manager', 'admin') THEN
        RAISE EXCEPTION 'Unauthorized: You can only process checkout on your own active register session';
    END IF;

    IF p_items IS NULL OR jsonb_typeof(p_items) != 'array' THEN
        RAISE EXCEPTION 'Malformed cart payload: Expected JSON array';
    END IF;

    v_item_count := jsonb_array_length(p_items);
    IF v_item_count = 0 THEN
        RAISE EXCEPTION 'Cart is empty: At least one item is required to complete checkout';
    END IF;

    IF v_item_count > 100 THEN
        RAISE EXCEPTION 'Cart exceeds maximum allowed items (100)';
    END IF;

    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        IF jsonb_typeof(v_elem) != 'object' THEN
            RAISE EXCEPTION 'Malformed item element: Expected JSON object';
        END IF;

        IF NOT (v_elem ? 'product_id' AND v_elem ? 'quantity_or_weight') THEN
            RAISE EXCEPTION 'Malformed item element: Must contain product_id and quantity_or_weight';
        END IF;

        v_pid_text := v_elem->>'product_id';
        IF v_pid_text IS NULL OR v_pid_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'Malformed product_id "%": Expected valid UUID string', v_pid_text;
        END IF;

        IF jsonb_typeof(v_elem->'quantity_or_weight') != 'number' THEN
            RAISE EXCEPTION 'Malformed quantity_or_weight for product %: Expected numeric value', v_pid_text;
        END IF;

        v_raw_qty := (v_elem->>'quantity_or_weight')::NUMERIC;
        IF v_raw_qty <= 0.000 OR v_raw_qty > 1000.000 THEN
            RAISE EXCEPTION 'Invalid quantity_or_weight %: Must be between 0.001 and 1000.000', v_raw_qty;
        END IF;

        IF scale(v_raw_qty) > 3 THEN
            RAISE EXCEPTION 'Invalid quantity_or_weight %: Precision exceeds supported 3 decimal places (grams)', v_elem->>'quantity_or_weight';
        END IF;
    END LOOP;

    SELECT COUNT(DISTINCT (x->>'product_id')::UUID) INTO v_distinct_count
    FROM jsonb_array_elements(p_items) AS x;

    IF v_distinct_count < v_item_count THEN
        RAISE EXCEPTION 'Duplicate product IDs detected in cart payload. Quantities must be consolidated';
    END IF;

    SELECT jsonb_agg(
        jsonb_build_object(
            'product_id', (x->>'product_id')::UUID,
            'quantity_or_weight', (x->>'quantity_or_weight')::NUMERIC(10, 3)
        ) ORDER BY (x->>'product_id')::UUID
    ) INTO v_canonical_json
    FROM jsonb_array_elements(p_items) AS x;

    v_payload_hash := encode(digest(v_canonical_json::TEXT::bytea, 'sha256'), 'hex');

    v_lock_key := ('x' || substr(md5(v_profile.current_store_id::TEXT || ':' || p_idempotency_key::TEXT), 1, 16))::bit(64)::BIGINT;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT id, order_number, subtotal, tax_amount, total_amount, payload_hash, receipt_token
    INTO v_existing_order
    FROM orders
    WHERE store_id = v_profile.current_store_id AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing_order.payload_hash != v_payload_hash THEN
            RAISE EXCEPTION 'Idempotency conflict: Key % already used with different cart payload', p_idempotency_key;
        END IF;

        RETURN jsonb_build_object(
            'success', true,
            'is_duplicate', true,
            'order_id', v_existing_order.id,
            'order_number', v_existing_order.order_number,
            'subtotal', v_existing_order.subtotal,
            'tax_amount', v_existing_order.tax_amount,
            'total_amount', v_existing_order.total_amount,
            'receipt_token', v_existing_order.receipt_token
        );
    END IF;

    FOR v_item IN
        SELECT (x->>'product_id')::UUID AS product_id, (x->>'quantity_or_weight')::NUMERIC(10, 3) AS quantity_or_weight
        FROM jsonb_array_elements(p_items) AS x
        ORDER BY (x->>'product_id')::UUID
    LOOP
        v_qty_or_weight := v_item.quantity_or_weight;

        SELECT id, name, product_type, unit, price_per_unit, tax_rate_percent, stock_quantity
        INTO v_db_product
        FROM products
        WHERE id = v_item.product_id AND store_id = v_profile.current_store_id AND is_active = TRUE
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Product % is invalid, inactive, or not in store catalog', v_item.product_id;
        END IF;

        IF v_db_product.product_type = 'loose' THEN
            IF v_db_product.unit != 'kg' THEN
                RAISE EXCEPTION 'Internal error: Loose product % unit must be kg', v_db_product.name;
            END IF;
        ELSIF v_db_product.product_type = 'packaged' THEN
            IF v_qty_or_weight != TRUNC(v_qty_or_weight) THEN
                RAISE EXCEPTION 'Packaged product "%" must be purchased in integer units (Requested: %)', v_db_product.name, v_qty_or_weight;
            END IF;
        END IF;

        IF v_db_product.stock_quantity < v_qty_or_weight THEN
            RAISE EXCEPTION 'Insufficient stock for product "%". Available: %, Requested: %',
                v_db_product.name, v_db_product.stock_quantity, v_qty_or_weight;
        END IF;

        v_line_base  := ROUND((v_qty_or_weight * v_db_product.price_per_unit), 2);
        v_line_tax   := ROUND((v_line_base * (v_db_product.tax_rate_percent / 100.0)), 2);
        v_line_total := v_line_base + v_line_tax;

        v_calc_subtotal  := v_calc_subtotal + v_line_base;
        v_calc_tax_total := v_calc_tax_total + v_line_tax;

        v_prep_pids         := array_append(v_prep_pids, v_db_product.id);
        v_prep_qtys         := array_append(v_prep_qtys, v_qty_or_weight);
        v_prep_names        := array_append(v_prep_names, v_db_product.name);
        v_prep_types        := array_append(v_prep_types, v_db_product.product_type);
        v_prep_units        := array_append(v_prep_units, v_db_product.unit);
        v_prep_prices       := array_append(v_prep_prices, v_db_product.price_per_unit);
        v_prep_bases        := array_append(v_prep_bases, v_line_base);
        v_prep_tax_rates    := array_append(v_prep_tax_rates, v_db_product.tax_rate_percent);
        v_prep_tax_amounts  := array_append(v_prep_tax_amounts, v_line_tax);
        v_prep_totals       := array_append(v_prep_totals, v_line_total);
        v_prep_new_stocks   := array_append(v_prep_new_stocks, (v_db_product.stock_quantity - v_qty_or_weight));
    END LOOP;

    v_calc_grand_total := v_calc_subtotal + v_calc_tax_total;
    v_order_number := 'ORD-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(NEXTVAL('order_number_seq')::TEXT, 6, '0');

    INSERT INTO orders (
        store_id, order_number, retailer_id, register_session_id, idempotency_key, payload_hash,
        subtotal, tax_amount, total_amount, status, receipt_token
    ) VALUES (
        v_profile.current_store_id, v_order_number, v_profile.profile_id, p_register_session_id, p_idempotency_key, v_payload_hash,
        v_calc_subtotal, v_calc_tax_total, v_calc_grand_total, 'checkout_completed', v_receipt_token
    ) RETURNING id INTO v_order_id;

    PERFORM set_config('app.authorized_stock_ctx', 'valid', true);

    FOR v_idx IN 1 .. array_length(v_prep_pids, 1)
    LOOP
        UPDATE products
        SET stock_quantity = v_prep_new_stocks[v_idx], updated_at = NOW()
        WHERE id = v_prep_pids[v_idx];

        INSERT INTO inventory_movements (
            store_id, product_id, movement_type, quantity_delta, resulting_stock, order_id, authorized_by, reason
        ) VALUES (
            v_profile.current_store_id, v_prep_pids[v_idx], 'SALE', -v_prep_qtys[v_idx], v_prep_new_stocks[v_idx],
            v_order_id, v_profile.profile_id, 'Completed Checkout: ' || v_order_number
        );

        INSERT INTO order_items (
            order_id, product_id, store_id, product_name_snapshot, product_type_snapshot,
            unit_snapshot, unit_price_snapshot, base_subtotal_snapshot, tax_rate_snapshot, tax_amount_snapshot,
            quantity_or_weight, item_total
        ) VALUES (
            v_order_id, v_prep_pids[v_idx], v_profile.current_store_id, v_prep_names[v_idx], v_prep_types[v_idx],
            v_prep_units[v_idx], v_prep_prices[v_idx], v_prep_bases[v_idx], v_prep_tax_rates[v_idx], v_prep_tax_amounts[v_idx],
            v_prep_qtys[v_idx], v_prep_totals[v_idx]
        );
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'is_duplicate', false,
        'order_id', v_order_id,
        'order_number', v_order_number,
        'subtotal', v_calc_subtotal,
        'tax_amount', v_calc_tax_total,
        'total_amount', v_calc_grand_total,
        'receipt_token', v_receipt_token
    );
END;
$$;
ALTER FUNCTION public.process_checkout(JSONB, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_checkout(JSONB, UUID, UUID) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.process_checkout(JSONB, UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_completed_order(
    p_order_id UUID,
    p_cancellation_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_profile RECORD;
    v_order RECORD;
    v_item RECORD;
    v_canc_num TEXT;
    v_new_stock NUMERIC(10, 3);
BEGIN
    SELECT profile_id, current_store_id, user_role INTO v_profile FROM get_current_retailer_profile();
    IF v_profile.profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Active retailer profile required';
    END IF;

    IF v_profile.user_role NOT IN ('store_manager', 'admin') THEN
        RAISE EXCEPTION 'Unauthorized: Only store managers or administrators can cancel completed orders';
    END IF;

    IF TRIM(COALESCE(p_cancellation_reason, '')) = '' THEN
        RAISE EXCEPTION 'Cancellation reason is mandatory';
    END IF;

    PERFORM pg_advisory_xact_lock(('x' || substr(md5('cancel_order:' || p_order_id::TEXT), 1, 16))::bit(64)::BIGINT);

    SELECT id, order_number, status
    INTO v_order
    FROM orders
    WHERE id = p_order_id AND store_id = v_profile.current_store_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Order % not found in current store', p_order_id;
    END IF;

    IF EXISTS (SELECT 1 FROM order_cancellations WHERE order_id = v_order.id) THEN
        RAISE EXCEPTION 'Order % has already been cancelled', v_order.order_number;
    END IF;

    v_canc_num := 'CN-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(NEXTVAL('cancellation_number_seq')::TEXT, 6, '0');

    INSERT INTO order_cancellations (
        order_id, store_id, cancelled_by, cancellation_number, reason
    ) VALUES (
        v_order.id, v_profile.current_store_id, v_profile.profile_id, v_canc_num, TRIM(p_cancellation_reason)
    );

    PERFORM set_config('app.authorized_stock_ctx', 'valid', true);

    FOR v_item IN
        SELECT oi.product_id, oi.quantity_or_weight, p.stock_quantity
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = v_order.id
        ORDER BY oi.product_id
        FOR UPDATE OF p
    LOOP
        v_new_stock := v_item.stock_quantity + v_item.quantity_or_weight;

        IF v_new_stock > 9999999.999 THEN
            RAISE EXCEPTION 'Cancellation rejected: Restored stock exceeds maximum limit (9,999,999.999)';
        END IF;

        UPDATE products
        SET stock_quantity = v_new_stock, updated_at = NOW()
        WHERE id = v_item.product_id;

        INSERT INTO inventory_movements (
            store_id, product_id, movement_type, quantity_delta, resulting_stock, order_id, authorized_by, reason
        ) VALUES (
            v_profile.current_store_id, v_item.product_id, 'RESTOCK', v_item.quantity_or_weight, v_new_stock,
            v_order.id, v_profile.profile_id, 'Order Cancellation ' || v_canc_num || ': ' || v_order.order_number
        );
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'cancellation_number', v_canc_num,
        'order_id', v_order.id,
        'order_number', v_order.order_number
    );
END;
$$;
ALTER FUNCTION public.cancel_completed_order(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cancel_completed_order(UUID, TEXT) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cancel_completed_order(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.generate_scanner_pairing_code(
    p_register_session_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_profile RECORD;
    v_session RECORD;
    v_bytes BYTEA;
    v_raw_val BIGINT;
    v_pin TEXT;
    v_expires_at TIMESTAMPTZ := NOW() + INTERVAL '10 minutes';
BEGIN
    SELECT profile_id, current_store_id, user_role INTO v_profile FROM get_current_retailer_profile();
    IF v_profile.profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Retailer profile required';
    END IF;

    SELECT id, retailer_id, status, expires_at INTO v_session
    FROM register_sessions
    WHERE id = p_register_session_id AND store_id = v_profile.current_store_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Register session not found in current store';
    END IF;

    IF v_session.status != 'ACTIVE' OR v_session.expires_at <= NOW() THEN
        RAISE EXCEPTION 'Register session is closed or expired';
    END IF;

    IF v_session.retailer_id != v_profile.profile_id AND v_profile.user_role NOT IN ('store_manager', 'admin') THEN
        RAISE EXCEPTION 'Unauthorized: You do not own this register session';
    END IF;

    UPDATE scanner_pairings
    SET is_active = FALSE
    WHERE store_id = v_profile.current_store_id
      AND is_active = TRUE
      AND (expires_at <= NOW() OR register_session_id = p_register_session_id);

    LOOP
        v_bytes := gen_random_bytes(4);
        v_raw_val := (get_byte(v_bytes, 0)::BIGINT << 24)
                   | (get_byte(v_bytes, 1)::BIGINT << 16)
                   | (get_byte(v_bytes, 2)::BIGINT << 8)
                   | get_byte(v_bytes, 3)::BIGINT;

        IF v_raw_val < 4294800000 THEN
            v_pin := (100000 + (v_raw_val % 900000))::TEXT;
            BEGIN
                INSERT INTO scanner_pairings (
                    store_id, register_session_id, retailer_id, pairing_code, expires_at, is_active
                ) VALUES (
                    v_profile.current_store_id, p_register_session_id, v_profile.profile_id, v_pin, v_expires_at, TRUE
                );
                EXIT;
            EXCEPTION WHEN unique_violation THEN
                NULL;
            END;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'pairing_code', v_pin,
        'expires_at', v_expires_at
    );
END;
$$;
ALTER FUNCTION public.generate_scanner_pairing_code(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.generate_scanner_pairing_code(UUID) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.generate_scanner_pairing_code(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.validate_scanner_pairing(
    p_store_code TEXT,
    p_pairing_code TEXT,
    p_client_identifier TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_store RECORD;
    v_rate RECORD;
    v_pairing RECORD;
    v_raw_token TEXT;
    v_token_hash TEXT;
    v_session_expires TIMESTAMPTZ := NOW() + INTERVAL '8 hours';
    v_client_id TEXT;
    v_store_c TEXT;
BEGIN
    v_client_id := TRIM(COALESCE(p_client_identifier, ''));
    v_store_c := TRIM(COALESCE(p_store_code, ''));

    IF v_client_id = '' OR length(v_client_id) > 64 OR v_client_id !~ '^[a-zA-Z0-9_\-\.:]{1,64}$' THEN
        v_client_id := 'untrusted_client';
    END IF;

    IF v_store_c = '' OR length(v_store_c) > 32 THEN
        v_store_c := 'unknown_store';
    END IF;

    INSERT INTO pairing_rate_limits (store_code, client_identifier, failed_attempts, window_started_at)
    VALUES (v_store_c, v_client_id, 0, NOW())
    ON CONFLICT (store_code, client_identifier) DO NOTHING;

    SELECT id, failed_attempts, window_started_at, locked_until
    INTO v_rate
    FROM pairing_rate_limits
    WHERE store_code = v_store_c AND client_identifier = v_client_id
    FOR UPDATE;

    IF v_rate.locked_until IS NOT NULL AND v_rate.locked_until > NOW() THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Too many failed attempts. Try again later');
    END IF;

    IF v_rate.window_started_at < NOW() - INTERVAL '15 minutes' THEN
        UPDATE pairing_rate_limits
        SET failed_attempts = 0, window_started_at = NOW(), locked_until = NULL, updated_at = NOW()
        WHERE id = v_rate.id;
        v_rate.failed_attempts := 0;
    END IF;

    IF p_pairing_code IS NULL OR p_pairing_code !~ '^\d{6}$' OR v_store_c = 'unknown_store' THEN
        UPDATE pairing_rate_limits
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END,
            updated_at = NOW()
        WHERE id = v_rate.id;
        RETURN jsonb_build_object('valid', false, 'error', 'Invalid pairing attempt');
    END IF;

    SELECT id, is_active INTO v_store FROM stores WHERE store_code = v_store_c;
    IF NOT FOUND OR NOT v_store.is_active THEN
        UPDATE pairing_rate_limits
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END,
            updated_at = NOW()
        WHERE id = v_rate.id;
        RETURN jsonb_build_object('valid', false, 'error', 'Invalid pairing attempt');
    END IF;

    -- 1. Atomic row lock with valid PostgreSQL clause order: ORDER BY -> LIMIT -> FOR UPDATE
    SELECT sp.id, sp.register_session_id, sp.expires_at
    INTO v_pairing
    FROM scanner_pairings sp
    JOIN register_sessions rs ON rs.id = sp.register_session_id AND rs.store_id = v_store.id
    WHERE sp.pairing_code = p_pairing_code
      AND sp.store_id = v_store.id
      AND sp.is_active = TRUE
      AND sp.is_consumed = FALSE
      AND rs.status = 'ACTIVE'
      AND rs.expires_at > NOW()
    ORDER BY sp.created_at DESC
    LIMIT 1
    FOR UPDATE OF sp;

    IF NOT FOUND THEN
        UPDATE pairing_rate_limits
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END,
            updated_at = NOW()
        WHERE id = v_rate.id;
        RETURN jsonb_build_object('valid', false, 'error', 'Invalid pairing attempt');
    END IF;

    -- 2. Immediate deactivation of expired code encountered during validation
    IF v_pairing.expires_at <= NOW() THEN
        UPDATE scanner_pairings
        SET is_active = FALSE
        WHERE id = v_pairing.id;

        UPDATE pairing_rate_limits
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END,
            updated_at = NOW()
        WHERE id = v_rate.id;
        RETURN jsonb_build_object('valid', false, 'error', 'Invalid pairing attempt');
    END IF;

    -- 3. Consume strictly this single locked row by primary key
    UPDATE scanner_pairings
    SET is_active = FALSE, is_consumed = TRUE, consumed_at = NOW()
    WHERE id = v_pairing.id;

    -- 4. Reset failed attempts upon successful authentication
    UPDATE pairing_rate_limits
    SET failed_attempts = 0, locked_until = NULL, updated_at = NOW()
    WHERE id = v_rate.id;

    v_raw_token := encode(gen_random_bytes(32), 'hex');
    v_token_hash := encode(digest(v_raw_token::bytea, 'sha256'), 'hex');

    INSERT INTO scanner_sessions (
        store_id, register_session_id, pairing_id, token_hash, expires_at
    ) VALUES (
        v_store.id, v_pairing.register_session_id, v_pairing.id, v_token_hash, v_session_expires
    );

    RETURN jsonb_build_object(
        'valid', true,
        'session_token', v_raw_token,
        'expires_at', v_session_expires
    );
END;
$$;
ALTER FUNCTION public.validate_scanner_pairing(TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.validate_scanner_pairing(TEXT, TEXT, TEXT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_scanner_pairing(TEXT, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.verify_scanner_scan(
    p_session_token TEXT,
    p_barcode TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_token_hash TEXT;
    v_session RECORD;
    v_product RECORD;
BEGIN
    IF p_session_token IS NULL OR TRIM(p_session_token) = '' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Session token is required');
    END IF;

    v_token_hash := encode(digest(p_session_token::bytea, 'sha256'), 'hex');

    SELECT s.id, s.store_id, r.status AS reg_status, r.expires_at AS reg_expires, st.is_active AS store_active
    INTO v_session
    FROM scanner_sessions s
    JOIN register_sessions r ON r.id = s.register_session_id
    JOIN stores st ON st.id = s.store_id
    WHERE s.token_hash = v_token_hash
      AND s.is_revoked = FALSE
      AND s.expires_at > NOW();

    IF NOT FOUND OR v_session.reg_status != 'ACTIVE' OR v_session.reg_expires <= NOW() OR NOT v_session.store_active THEN
        RETURN jsonb_build_object('success', false, 'error', 'Scanner session is invalid, closed, or expired');
    END IF;

    UPDATE scanner_sessions SET last_activity_at = NOW() WHERE id = v_session.id;

    SELECT id, name, unit, price_per_unit, tax_rate_percent, stock_quantity
    INTO v_product
    FROM products
    WHERE store_id = v_session.store_id AND barcode = p_barcode AND is_active = TRUE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Barcode not registered in store catalog');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'product', jsonb_build_object(
            'product_id', v_product.id,
            'name', v_product.name,
            'unit', v_product.unit,
            'price_per_unit', v_product.price_per_unit,
            'tax_rate_percent', v_product.tax_rate_percent,
            'is_available', (v_product.stock_quantity > 0.000)
        )
    );
END;
$$;
ALTER FUNCTION public.verify_scanner_scan(TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.verify_scanner_scan(TEXT, TEXT) FROM public;
GRANT EXECUTE ON FUNCTION public.verify_scanner_scan(TEXT, TEXT) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_receipt_by_token(
    p_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_result JSONB;
BEGIN
    IF p_token IS NULL THEN
        RAISE EXCEPTION 'Invalid receipt token';
    END IF;

    SELECT jsonb_build_object(
        'order_number', o.order_number,
        'date', o.created_at,
        'store_name', s.name,
        'store_address', s.address,
        'subtotal', o.subtotal,
        'tax_amount', o.tax_amount,
        'total_amount', o.total_amount,
        'status', CASE WHEN c.id IS NOT NULL THEN 'cancelled' ELSE o.status::TEXT END,
        'cancellation', CASE WHEN c.id IS NOT NULL THEN jsonb_build_object(
            'cancellation_number', c.cancellation_number,
            'cancelled_at', c.created_at,
            'reason', c.reason
        ) ELSE NULL END,
        'items', (
            SELECT jsonb_agg(jsonb_build_object(
                'name', oi.product_name_snapshot,
                'type', oi.product_type_snapshot,
                'unit', oi.unit_snapshot,
                'unit_price', oi.unit_price_snapshot,
                'base_subtotal', oi.base_subtotal_snapshot,
                'tax_rate', oi.tax_rate_snapshot,
                'tax_amount', oi.tax_amount_snapshot,
                'quantity_or_weight', oi.quantity_or_weight,
                'item_total', oi.item_total
            ) ORDER BY oi.created_at)
            FROM order_items oi
            WHERE oi.order_id = o.id
        )
    )
    INTO v_result
    FROM orders o
    JOIN stores s ON s.id = o.store_id
    LEFT JOIN order_cancellations c ON c.order_id = o.id
    WHERE o.receipt_token = p_token;

    IF v_result IS NULL THEN
        RAISE EXCEPTION 'Receipt not found or invalid token';
    END IF;

    RETURN v_result;
END;
$$;
ALTER FUNCTION public.get_receipt_by_token(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_receipt_by_token(UUID) FROM public;
GRANT EXECUTE ON FUNCTION public.get_receipt_by_token(UUID) TO anon, authenticated;

-- Refresh PostgREST schema cache immediately
NOTIFY pgrst, 'reload schema';

COMMIT;

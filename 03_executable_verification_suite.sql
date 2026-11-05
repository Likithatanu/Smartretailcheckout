-- =============================================================================
-- AI SMART RETAIL CHECKOUT — PHASE 1 EXECUTABLE VERIFICATION SUITE
-- PLANNED TEST SUITE (Safe, isolated harness with ZERO auth.users pollution)
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- SECTION A: DATABASE OWNER SETUP (Runs as postgres / superuser)
-- -----------------------------------------------------------------------------
-- Safely isolate test identities from the managed Supabase Auth service:
-- 1. We drop the foreign key from profiles -> auth.users strictly inside this transaction.
-- 2. This completely eliminates synthetic inserts into auth.users, avoiding conflicts
--    with Supabase Auth webhooks, GoTrue profile triggers, or user metadata constraints.
-- 3. Upon ROLLBACK at the end of this script, the foreign key constraint is fully restored.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS fk_profiles_auth_user;
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;

DO $$
DECLARE
    v_store_a         UUID;
    v_store_b         UUID;
    v_user_cashier_a  UUID := gen_random_uuid();
    v_user_manager_a  UUID := gen_random_uuid();
    v_user_cashier_b  UUID := gen_random_uuid();
    v_prod_loose_a    UUID;
    v_prod_pack_a     UUID;
    v_prod_loose_b    UUID;
    v_session_b       UUID := gen_random_uuid();
    v_order_b         UUID := gen_random_uuid();
BEGIN
    -- 1. Create Stores
    INSERT INTO stores (name, store_code, address)
    VALUES ('Test Store A', 'TST_A', 'MG Road, Bangalore') RETURNING id INTO v_store_a;

    INSERT INTO stores (name, store_code, address)
    VALUES ('Test Store B', 'TST_B', 'Anna Salai, Chennai') RETURNING id INTO v_store_b;

    -- 2. Create Profiles directly without touching auth.users
    INSERT INTO profiles (id, store_id, role, full_name, email)
    VALUES (v_user_cashier_a, v_store_a, 'retailer', 'Cashier A', 'cashier_a@test.com');

    INSERT INTO profiles (id, store_id, role, full_name, email)
    VALUES (v_user_manager_a, v_store_a, 'store_manager', 'Manager A', 'manager_a@test.com');

    INSERT INTO profiles (id, store_id, role, full_name, email)
    VALUES (v_user_cashier_b, v_store_b, 'retailer', 'Cashier B', 'cashier_b@test.com');

    -- 3. Create Products (stock_quantity forced to 0.000 by trigger trg_force_zero_initial_stock)
    INSERT INTO products (store_id, name, product_type, model_class, unit, price_per_unit, tax_rate_percent, stock_quantity)
    VALUES (v_store_a, 'Chana Dal Premium', 'loose', 'chana_dal', 'kg', 120.00, 0.00, 0.000)
    RETURNING id INTO v_prod_loose_a;

    INSERT INTO products (store_id, name, product_type, barcode, unit, price_per_unit, tax_rate_percent, stock_quantity)
    VALUES (v_store_a, 'Biscuits 100g', 'packaged', '8901234567890', 'pack', 40.00, 5.00, 0.000)
    RETURNING id INTO v_prod_pack_a;

    INSERT INTO products (store_id, name, product_type, model_class, unit, price_per_unit, tax_rate_percent, stock_quantity)
    VALUES (v_store_b, 'Masur Dal Store B', 'loose', 'masur_dal', 'kg', 100.00, 0.00, 0.000)
    RETURNING id INTO v_prod_loose_b;

    -- 4. Create Store B Register Session & Order Fixture (Strict Schema Conformance)
    INSERT INTO register_sessions (id, store_id, retailer_id, register_name, status)
    VALUES (v_session_b, v_store_b, v_user_cashier_b, 'Register B Counter 1', 'ACTIVE');

    INSERT INTO orders (
        id,
        store_id,
        order_number,
        retailer_id,
        register_session_id,
        idempotency_key,
        payload_hash,
        subtotal,
        tax_amount,
        total_amount,
        status,
        receipt_token
    ) VALUES (
        v_order_b,
        v_store_b,
        'ORD-TST-B-0001',
        v_user_cashier_b,
        v_session_b,
        gen_random_uuid(),
        'test_hash_payload_b',
        50.00,
        2.50,
        52.50,
        'checkout_completed',
        gen_random_uuid()
    );

    -- Persist references in transaction-local settings
    PERFORM set_config('test.store_a', v_store_a::TEXT, true);
    PERFORM set_config('test.store_b', v_store_b::TEXT, true);
    PERFORM set_config('test.cashier_a', v_user_cashier_a::TEXT, true);
    PERFORM set_config('test.manager_a', v_user_manager_a::TEXT, true);
    PERFORM set_config('test.cashier_b', v_user_cashier_b::TEXT, true);
    PERFORM set_config('test.prod_loose_a', v_prod_loose_a::TEXT, true);
    PERFORM set_config('test.prod_pack_a', v_prod_pack_a::TEXT, true);
    PERFORM set_config('test.prod_loose_b', v_prod_loose_b::TEXT, true);
    PERFORM set_config('test.session_b', v_session_b::TEXT, true);
    PERFORM set_config('test.order_b', v_order_b::TEXT, true);
END $$;

-- -----------------------------------------------------------------------------
-- SECTION B: ANONYMOUS ROLE VERIFICATION (SET LOCAL ROLE anon)
-- -----------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE anon;

DO $$
DECLARE
    v_test_passed BOOLEAN := FALSE;
    v_dummy INT;
BEGIN
    RAISE NOTICE '--- TEST B1: ANONYMOUS TABLE ACCESS BLOCKED WITH INSUFFICIENT_PRIVILEGE ---';
    BEGIN
        SELECT count(*) INTO v_dummy FROM products;
    EXCEPTION WHEN insufficient_privilege THEN
        v_test_passed := TRUE;
    END;
    IF NOT v_test_passed THEN
        RAISE EXCEPTION 'TEST B1 ASSERTION FAILED: Anonymous SELECT on products did not throw insufficient_privilege';
    END IF;

    v_test_passed := FALSE;
    BEGIN
        SELECT count(*) INTO v_dummy FROM orders;
    EXCEPTION WHEN insufficient_privilege THEN
        v_test_passed := TRUE;
    END;
    IF NOT v_test_passed THEN
        RAISE EXCEPTION 'TEST B1 ASSERTION FAILED: Anonymous SELECT on orders did not throw insufficient_privilege';
    END IF;

    v_test_passed := FALSE;
    BEGIN
        SELECT count(*) INTO v_dummy FROM scanner_pairings;
    EXCEPTION WHEN insufficient_privilege THEN
        v_test_passed := TRUE;
    END;
    IF NOT v_test_passed THEN
        RAISE EXCEPTION 'TEST B1 ASSERTION FAILED: Anonymous SELECT on scanner_pairings did not throw insufficient_privilege';
    END IF;
    RAISE NOTICE 'TEST B1 PASSED: Anonymous table queries rejected with insufficient_privilege.';
END $$;

-- -----------------------------------------------------------------------------
-- SECTION C: AUTHENTICATED CASHIER ROLE VERIFICATION (SET LOCAL ROLE authenticated)
-- -----------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    v_cashier_a UUID := current_setting('test.cashier_a')::UUID;
    v_store_b UUID := current_setting('test.store_b')::UUID;
    v_count INT;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_cashier_a::TEXT, true);

    RAISE NOTICE '--- TEST C1: CASHIER CAN ONLY SEE OWN PROFILE ---';
    SELECT COUNT(*) INTO v_count FROM profiles;
    IF v_count != 1 THEN
        RAISE EXCEPTION 'TEST C1 ASSERTION FAILED: Cashier sees % profiles instead of 1 (own profile)', v_count;
    END IF;
    RAISE NOTICE 'TEST C1 PASSED: Cashier profile isolation verified.';

    RAISE NOTICE '--- TEST C2: CASHIER CANNOT READ STORE B PRODUCTS ---';
    SELECT COUNT(*) INTO v_count FROM products WHERE store_id = v_store_b;
    IF v_count != 0 THEN
        RAISE EXCEPTION 'TEST C2 ASSERTION FAILED: Cashier A can read Store B products (count: %)', v_count;
    END IF;
    RAISE NOTICE 'TEST C2 PASSED: Cross-store product read blocked by RLS.';
END $$;

-- -----------------------------------------------------------------------------
-- SECTION D: AUTHENTICATED MANAGER ROLE VERIFICATION (SET LOCAL ROLE authenticated)
-- -----------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    v_manager_a UUID := current_setting('test.manager_a')::UUID;
    v_count INT;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_manager_a::TEXT, true);

    RAISE NOTICE '--- TEST D1: MANAGER SEES ALL STORE PROFILES ---';
    SELECT COUNT(*) INTO v_count FROM profiles;
    IF v_count != 2 THEN
        RAISE EXCEPTION 'TEST D1 ASSERTION FAILED: Manager sees % profiles instead of 2 in Store A', v_count;
    END IF;
    RAISE NOTICE 'TEST D1 PASSED: Manager store profile visibility verified.';
END $$;

-- -----------------------------------------------------------------------------
-- SECTION E: AUTHENTICATED CASHIER SESSION & SECURITY BOUNDARY CHECK
-- -----------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE authenticated;

DO $$
DECLARE
    v_store_a UUID := current_setting('test.store_a')::UUID;
    v_store_b UUID := current_setting('test.store_b')::UUID;
    v_cashier_a UUID := current_setting('test.cashier_a')::UUID;
    v_manager_a UUID := current_setting('test.manager_a')::UUID;
    v_cashier_b UUID := current_setting('test.cashier_b')::UUID;
    v_prod_loose_a UUID := current_setting('test.prod_loose_a')::UUID;
    v_prod_pack_a UUID := current_setting('test.prod_pack_a')::UUID;
    v_session_a UUID;
    v_session_b UUID;
    v_res JSONB;
    v_pin TEXT;
    v_invalid_pin TEXT;
    v_test_passed BOOLEAN;
BEGIN
    -- 1. Manager restocks products
    PERFORM set_config('request.jwt.claim.sub', v_manager_a::TEXT, true);
    PERFORM adjust_inventory_stock(v_prod_loose_a, 20.000, 'RESTOCK', 'Restock Chana Dal');
    PERFORM adjust_inventory_stock(v_prod_pack_a, 50.000, 'RESTOCK', 'Restock Biscuits');

    -- 2. Open Cashier A register session
    PERFORM set_config('request.jwt.claim.sub', v_cashier_a::TEXT, true);
    v_res := open_register_session('Register Counter 1');
    v_session_a := (v_res->>'register_session_id')::UUID;

    -- 3. Open Cashier B register session (in Store B)
    PERFORM set_config('request.jwt.claim.sub', v_cashier_b::TEXT, true);
    v_res := open_register_session('Register Store B');
    v_session_b := (v_res->>'register_session_id')::UUID;

    -- 4. Cross-Session Checkout Rejection: Cashier A cannot checkout on Session B
    PERFORM set_config('request.jwt.claim.sub', v_cashier_a::TEXT, true);
    v_test_passed := FALSE;
    BEGIN
        PERFORM process_checkout(
            jsonb_build_array(jsonb_build_object('product_id', v_prod_pack_a, 'quantity_or_weight', 1)),
            v_session_b,
            gen_random_uuid()
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Register session not found%' OR SQLERRM LIKE '%You can only process checkout on your own%' THEN
            v_test_passed := TRUE;
        END IF;
    END;
    IF NOT v_test_passed THEN
        RAISE EXCEPTION 'TEST E1 ASSERTION FAILED: Cashier was allowed to checkout against another register session';
    END IF;
    RAISE NOTICE 'TEST E1 PASSED: Register session ownership enforced in checkout.';

    -- 5. Cashier generates PIN
    v_res := generate_scanner_pairing_code(v_session_a);
    v_pin := v_res->>'pairing_code';
    v_invalid_pin := TO_CHAR(((v_pin::INT + 500000) % 900000 + 100000), 'FM000000');

    -- 6. Negative Security Test: authenticated caller MUST be denied execution of validate_scanner_pairing
    v_test_passed := FALSE;
    BEGIN
        PERFORM validate_scanner_pairing('TST_A', v_invalid_pin, 'client_probe');
    EXCEPTION WHEN insufficient_privilege THEN
        v_test_passed := TRUE;
    END;
    IF NOT v_test_passed THEN
        RAISE EXCEPTION 'TEST E2 ASSERTION FAILED: authenticated role was permitted to execute validate_scanner_pairing';
    END IF;
    RAISE NOTICE 'TEST E2 PASSED: Direct client execution of validate_scanner_pairing blocked with insufficient_privilege.';

    -- Persist session and pairing PIN for subsequent service_role and checkout blocks
    PERFORM set_config('test.session_a', v_session_a::TEXT, true);
    PERFORM set_config('test.pairing_pin', v_pin, true);
    PERFORM set_config('test.invalid_pin', v_invalid_pin, true);
END $$;

-- -----------------------------------------------------------------------------
-- SECTION F: SERVICE_ROLE SCANNER PAIRING VALIDATION & SCAN HANDOFF
-- -----------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE service_role;

DO $$
DECLARE
    v_prod_pack_a UUID := current_setting('test.prod_pack_a')::UUID;
    v_pin         TEXT := current_setting('test.pairing_pin');
    v_invalid_pin TEXT := current_setting('test.invalid_pin');
    v_res         JSONB;
    v_token       TEXT;
BEGIN
    RAISE NOTICE '--- TEST F1: SERVICE_ROLE EXECUTES RATE-LIMITED SCANNER PAIRING ---';

    -- 1. Rate-limiting: 5 invalid attempts lock the client fingerprint for 15 minutes
    FOR i IN 1..5 LOOP
        v_res := validate_scanner_pairing('TST_A', v_invalid_pin, 'fingerprint_test_1');
        IF (v_res->>'valid')::BOOLEAN != FALSE OR (v_res->>'error') != 'Invalid pairing attempt' THEN
            RAISE EXCEPTION 'TEST F1 ASSERTION FAILED: Bad PIN accepted or unexpected error: %', v_res;
        END IF;
    END LOOP;

    -- 6th attempt with valid PIN fails due to active client lockout
    v_res := validate_scanner_pairing('TST_A', v_pin, 'fingerprint_test_1');
    IF (v_res->>'valid')::BOOLEAN != FALSE OR (v_res->>'error') NOT LIKE '%Too many failed attempts%' THEN
        RAISE EXCEPTION 'TEST F1 ASSERTION FAILED: Client was not locked out after 5 attempts: %', v_res;
    END IF;

    -- 2. Legitimate client fingerprint consumes valid PIN
    v_res := validate_scanner_pairing('TST_A', v_pin, 'fingerprint_test_2');
    IF (v_res->>'valid')::BOOLEAN != TRUE OR (v_res->>'session_token') IS NULL THEN
        RAISE EXCEPTION 'TEST F1 ASSERTION FAILED: Legitimate PIN rejected: %', v_res;
    END IF;
    v_token := v_res->>'session_token';

    -- 3. Single-use assertion: Submitting the same PIN again must be rejected
    v_res := validate_scanner_pairing('TST_A', v_pin, 'fingerprint_test_3');
    IF (v_res->>'valid')::BOOLEAN != FALSE THEN
        RAISE EXCEPTION 'TEST F1 ASSERTION FAILED: Consumed pairing PIN was accepted a second time: %', v_res;
    END IF;

    RAISE NOTICE 'TEST F1 PASSED: Rate limiting, lockout, PIN consumption, and single-use enforcement verified as service_role.';

    -- 4. Scanner Handoff Contract
    RAISE NOTICE '--- TEST F2: SCANNER HANDOFF SCAN VERIFICATION ---';
    v_res := verify_scanner_scan(v_token, '8901234567890');
    IF (v_res->>'success')::BOOLEAN != TRUE OR (v_res->'product'->>'product_id')::UUID != v_prod_pack_a THEN
        RAISE EXCEPTION 'TEST F2 ASSERTION FAILED: verify_scanner_scan failed: %', v_res;
    END IF;
    RAISE NOTICE 'TEST F2 PASSED: Scanner scan handoff verified.';
END $$;

-- -----------------------------------------------------------------------------
-- SECTION G: AUTHENTICATED CASHIER CHECKOUT & IDEMPOTENCY
-- -----------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('test.cashier_a'), true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
DECLARE
    v_prod_loose_a    UUID := current_setting('test.prod_loose_a')::UUID;
    v_prod_pack_a     UUID := current_setting('test.prod_pack_a')::UUID;
    v_session_a       UUID := current_setting('test.session_a')::UUID;
    v_idempotency_key UUID := gen_random_uuid();
    v_order_id        UUID;
    v_receipt_token   UUID;
    v_res             JSONB;
    v_res2            JSONB;
    v_test_passed     BOOLEAN;
BEGIN
    RAISE NOTICE '--- TEST G1: QUANTITY SCALE REJECTION (>3 DECIMALS) ---';
    -- 1. Quantity Scale Rejection Test: Value with >3 decimal places must be rejected
    v_test_passed := FALSE;
    BEGIN
        PERFORM process_checkout(
            jsonb_build_array(jsonb_build_object('product_id', v_prod_loose_a, 'quantity_or_weight', 1.23456)),
            v_session_a,
            gen_random_uuid()
        );
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%Precision exceeds supported 3 decimal places%' THEN
            v_test_passed := TRUE;
        END IF;
    END;
    IF NOT v_test_passed THEN
        RAISE EXCEPTION 'TEST G1 ASSERTION FAILED: Unbounded scale >3 was not rejected';
    END IF;
    RAISE NOTICE 'TEST G1 PASSED: Quantities exceeding 3 decimal places rejected.';

    -- 2. Normalized Idempotency (2 vs 2.000)
    RAISE NOTICE '--- TEST G2: NORMALIZED IDEMPOTENCY (2 vs 2.000) ---';
    v_res := process_checkout(
        jsonb_build_array(jsonb_build_object('product_id', v_prod_pack_a, 'quantity_or_weight', 2)),
        v_session_a,
        v_idempotency_key
    );
    v_order_id := (v_res->>'order_id')::UUID;
    v_receipt_token := (v_res->>'receipt_token')::UUID;

    v_res2 := process_checkout(
        jsonb_build_array(jsonb_build_object('product_id', v_prod_pack_a, 'quantity_or_weight', 2.000)),
        v_session_a,
        v_idempotency_key
    );
    IF (v_res2->>'is_duplicate')::BOOLEAN != TRUE OR (v_res2->>'order_id')::UUID != v_order_id THEN
        RAISE EXCEPTION 'TEST G2 ASSERTION FAILED: Normalized quantity idempotency failed (2 vs 2.000): %', v_res2;
    END IF;
    RAISE NOTICE 'TEST G2 PASSED: Normalized quantity idempotency verified.';

    PERFORM set_config('test.order_id', v_order_id::TEXT, true);
    PERFORM set_config('test.receipt_token', v_receipt_token::TEXT, true);
END $$;
-- -----------------------------------------------------------------------------
-- SECTION H: MANAGER ORDER CANCELLATION & SINGLE-USE STOCK RESTORATION
-- -----------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('test.manager_a'), true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
DECLARE
    v_order_id             UUID := current_setting('test.order_id')::UUID;
    v_prod_pack_a          UUID := current_setting('test.prod_pack_a')::UUID;
    v_current_stock        NUMERIC(10, 3);
    v_table_order_status   order_status_enum;
    v_canc_count           INT;
    v_res                  JSONB;
    v_double_cancel_passed BOOLEAN := FALSE;
BEGIN
    RAISE NOTICE '--- TEST H1: MANAGER CANCELS COMPLETED ORDER ---';
    v_res := cancel_completed_order(v_order_id, 'Customer return test');
    IF (v_res->>'success')::BOOLEAN != TRUE OR (v_res->>'cancellation_number') NOT LIKE 'CN-%' THEN
        RAISE EXCEPTION 'TEST H1 FAIL: Order cancellation failed: %', v_res;
    END IF;

    -- 1. Assert orders table immutability: orders.status remains 'checkout_completed' in table
    SELECT status INTO v_table_order_status FROM orders WHERE id = v_order_id;
    IF v_table_order_status != 'checkout_completed' THEN
        RAISE EXCEPTION 'TEST H1 FAIL: orders table was mutated! Expected checkout_completed, found: %', v_table_order_status;
    END IF;

    -- 2. Assert cancellation record inserted into order_cancellations
    SELECT COUNT(*) INTO v_canc_count FROM order_cancellations WHERE order_id = v_order_id;
    IF v_canc_count != 1 THEN
        RAISE EXCEPTION 'TEST H1 FAIL: Expected 1 order_cancellations record, found: %', v_canc_count;
    END IF;

    -- 3. Assert stock is restored from 48.000 back to 50.000 exactly once
    SELECT stock_quantity INTO v_current_stock FROM products WHERE id = v_prod_pack_a;
    IF v_current_stock != 50.000 THEN
        RAISE EXCEPTION 'TEST H1 FAIL: Stock was not restored on cancellation! Expected 50.000, found: %', v_current_stock;
    END IF;

    -- 4. Assert double-cancellation is strictly blocked and stock is not restored twice
    BEGIN
        PERFORM cancel_completed_order(v_order_id, 'Duplicate cancellation attempt');
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%has already been cancelled%' THEN
            v_double_cancel_passed := TRUE;
        END IF;
    END;
    IF NOT v_double_cancel_passed THEN
        RAISE EXCEPTION 'TEST H1 FAIL: Duplicate cancellation was allowed!';
    END IF;

    -- 5. Confirm stock was restored strictly once (remains 50.000, not 52.000)
    SELECT stock_quantity INTO v_current_stock FROM products WHERE id = v_prod_pack_a;
    IF v_current_stock != 50.000 THEN
        RAISE EXCEPTION 'TEST H1 FAIL: Stock was double-restored! Expected 50.000, found: %', v_current_stock;
    END IF;

    RAISE NOTICE 'TEST H PASSED: Order cancellation, table immutability, single-use stock restoration, and duplicate-cancellation prevention verified.';
END $$;

-- -----------------------------------------------------------------------------
-- SECTION I: ANONYMOUS PUBLIC RECEIPT ACCESS & ID LEAKAGE AUDIT
-- -----------------------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE anon;

DO $$
DECLARE
    v_receipt_token UUID := current_setting('test.receipt_token')::UUID;
    v_res           JSONB;
BEGIN
    RAISE NOTICE '--- TEST I1: ANONYMOUS VIEWING OF CANCELLED RECEIPT ---';
    v_res := get_receipt_by_token(v_receipt_token);

    -- 1. Assert public receipt status evaluates to 'cancelled' via LEFT JOIN order_cancellations
    IF (v_res->>'status') != 'cancelled' THEN
        RAISE EXCEPTION 'TEST I1 FAIL: Public receipt status should be "cancelled", found: %', v_res->>'status';
    END IF;

    -- 2. Assert cancellation details are properly included in public receipt
    IF (v_res->'cancellation'->>'reason') != 'Customer return test'
       OR (v_res->'cancellation'->>'cancellation_number') NOT LIKE 'CN-%'
       OR (v_res->'cancellation'->>'cancelled_at') IS NULL THEN
        RAISE EXCEPTION 'TEST I1 FAIL: Public receipt missing valid cancellation metadata: %', v_res->'cancellation';
    END IF;

    -- 3. Assert zero leakage of internal database primary keys or store references
    IF v_res ? 'order_id'
       OR v_res ? 'store_id'
       OR v_res ? 'id'
       OR v_res ? 'retailer_id'
       OR v_res ? 'register_session_id'
       OR v_res ? 'idempotency_key'
       OR v_res ? 'payload_hash' THEN
        RAISE EXCEPTION 'TEST I1 FAIL: Public receipt leaked internal root IDs or hashes: %', v_res;
    END IF;

    -- 4. Assert line items do not leak internal product or item UUIDs
    IF (v_res->'items'->0) ? 'id'
       OR (v_res->'items'->0) ? 'order_id'
       OR (v_res->'items'->0) ? 'product_id'
       OR (v_res->'items'->0) ? 'store_id' THEN
        RAISE EXCEPTION 'TEST I1 FAIL: Public receipt items leaked internal product or line item UUIDs: %', v_res->'items'->0;
    END IF;

    -- 5. Assert receipt displays correct customer-facing summary
    IF (v_res->>'order_number') IS NULL
       OR (v_res->>'store_name') != 'Test Store A'
       OR (v_res->>'total_amount')::NUMERIC != 84.00 THEN
        RAISE EXCEPTION 'TEST I1 FAIL: Public receipt missing expected store or amount fields: %', v_res;
    END IF;

    RAISE NOTICE 'TEST I PASSED: Public receipt displays cancelled status, valid cancellation metadata, and zero internal ID leakage.';
    RAISE NOTICE '=== ALL PHASE 1 TESTS COMPLETED DETERMINISTICALLY ===';
END $$;

-- -----------------------------------------------------------------------------
-- CLEANUP: RESTORE ROLE & ROLLBACK TRANSACTION
-- -----------------------------------------------------------------------------
RESET ROLE;

ROLLBACK;

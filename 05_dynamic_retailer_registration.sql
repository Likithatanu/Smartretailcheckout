-- =============================================================================
-- Migration: 05_dynamic_retailer_registration.sql
-- Project: AI Smart Retail Checkout
-- Purpose: Hardened, Concurrency-Safe Dynamic Retailer Self-Registration RPC
-- Status: PROPOSED DRAFT ONLY — DO NOT APPLY TO LIVE DATABASE WITHOUT APPROVAL
-- =============================================================================

SET search_path = pg_catalog;

-- Create secure, atomic, idempotent stored procedure for registering a new store
-- and assigning the authenticated caller as its initial 'store_manager'.
CREATE OR REPLACE FUNCTION public.register_store_and_manager(
    p_store_name pg_catalog.text DEFAULT NULL,
    p_store_code pg_catalog.text DEFAULT NULL,
    p_default_tax_rate pg_catalog.numeric DEFAULT NULL,
    p_store_address pg_catalog.text DEFAULT NULL,
    p_full_name pg_catalog.text DEFAULT NULL
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_user_id             pg_catalog.uuid;
    v_user_email          pg_catalog.text;
    v_email_confirmed_at  pg_catalog.timestamptz;
    v_meta                pg_catalog.jsonb;
    v_user_full_name      pg_catalog.text;
    v_clean_store_name    pg_catalog.text;
    v_clean_store_code    pg_catalog.text;
    v_clean_address       pg_catalog.text;
    v_raw_tax_rate        pg_catalog.numeric;
    v_clean_tax_rate      pg_catalog.numeric(5, 2);
    v_store_id            pg_catalog.uuid;
    v_profile_record      RECORD;
    v_constraint_name     pg_catalog.text;
BEGIN
    -- 1. Authentication check: Caller MUST be an authenticated Supabase Auth user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'UNAUTHORIZED: An authenticated session is required to register a store.';
    END IF;

    -- 2. Concurrency guard: Serialize concurrent registration requests for this user session.
    -- The advisory lock key is derived via 64-bit hashtextextended(text, int8).
    -- Advisory lock keys are NOT unique user identifiers and are never used as entity IDs.
    -- Uniqueness is strictly enforced by the 128-bit UUID primary key on profiles(id)
    -- and the unique constraint on stores(store_code).
    -- Theoretical collision behavior: In the infinitesimal event that two different users
    -- produce the same 64-bit lock hash, the transactions simply serialize (one transaction
    -- waits for the other to commit). Once acquired, each transaction executes strictly for its
    -- own auth.uid(), with zero risk of cross-tenant data corruption or overwriting.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::pg_catalog.text, 0::pg_catalog.int8));

    -- 3. Profile State Check:
    -- Query any existing profile row for this user (both active and inactive)
    SELECT 
        p.id, 
        p.store_id, 
        p.role, 
        p.full_name, 
        p.email, 
        p.is_active,
        s.name AS store_name, 
        s.store_code, 
        s.default_tax_rate
    INTO v_profile_record
    FROM public.profiles p
    LEFT JOIN public.stores s ON s.id = p.store_id
    WHERE p.id = v_user_id;

    -- State A: Inactive profile -> reject with clear error; NEVER reassign or create another store
    IF v_profile_record.id IS NOT NULL AND v_profile_record.is_active = FALSE THEN
        RAISE EXCEPTION 'PROFILE_INACTIVE: This retailer profile has been deactivated. Please contact your store administrator.';
    END IF;

    -- State B: Active profile -> verify store integrity before returning existing profile idempotently
    IF v_profile_record.id IS NOT NULL AND v_profile_record.is_active = TRUE THEN
        IF v_profile_record.store_id IS NULL OR v_profile_record.store_name IS NULL THEN
            RAISE EXCEPTION 'DATA_INTEGRITY_ERROR: Retailer profile exists and is active but is linked to a missing or invalid store record. Please contact your administrator.';
        END IF;

        RETURN pg_catalog.jsonb_build_object(
            'success', true,
            'already_registered', true,
            'is_active', true,
            'message', 'Retailer account is already associated with an active store.',
            'profile', pg_catalog.jsonb_build_object(
                'id', v_profile_record.id,
                'store_id', v_profile_record.store_id,
                'role', v_profile_record.role,
                'full_name', v_profile_record.full_name,
                'email', v_profile_record.email,
                'store_name', v_profile_record.store_name,
                'store_code', v_profile_record.store_code,
                'default_tax_rate', v_profile_record.default_tax_rate
            )
        );
    END IF;

    -- State C: No profile -> continue with registration

    -- 4. Retrieve verified user identity from auth.users
    SELECT 
        email, 
        email_confirmed_at, 
        COALESCE(raw_user_meta_data, '{}'::pg_catalog.jsonb)
    INTO 
        v_user_email, 
        v_email_confirmed_at, 
        v_meta
    FROM auth.users
    WHERE id = v_user_id;

    IF v_user_email IS NULL THEN
        RAISE EXCEPTION 'USER_NOT_FOUND: Authenticated user record could not be found in auth.users.';
    END IF;

    -- 5. Email Confirmation verification:
    IF v_email_confirmed_at IS NULL THEN
        RAISE EXCEPTION 'EMAIL_NOT_CONFIRMED: Retailer email must be verified before store activation.';
    END IF;

    -- 6. Parameter Resolution: Prefer explicit arguments; fallback to auth.users raw_user_meta_data
    v_user_full_name := NULLIF(pg_catalog.btrim(COALESCE(p_full_name, v_meta->>'full_name', '')), '');
    IF v_user_full_name IS NULL THEN
        v_user_full_name := pg_catalog.split_part(v_user_email, '@', 1);
    END IF;

    v_clean_store_name := NULLIF(pg_catalog.btrim(COALESCE(p_store_name, v_meta->>'store_name', '')), '');
    IF v_clean_store_name IS NULL OR pg_catalog.char_length(v_clean_store_name) < 2 OR pg_catalog.char_length(v_clean_store_name) > 100 THEN
        RAISE EXCEPTION 'INVALID_STORE_NAME: Store name must be between 2 and 100 characters.';
    END IF;

    v_clean_store_code := pg_catalog.upper(NULLIF(pg_catalog.btrim(COALESCE(p_store_code, v_meta->>'store_code', '')), ''));
    IF v_clean_store_code IS NULL OR pg_catalog.char_length(v_clean_store_code) < 3 OR pg_catalog.char_length(v_clean_store_code) > 50 THEN
        RAISE EXCEPTION 'INVALID_STORE_CODE: Store code must be between 3 and 50 characters.';
    END IF;

    IF v_clean_store_code !~ '^[A-Z0-9_-]+$' THEN
        RAISE EXCEPTION 'INVALID_STORE_CODE: Store code may only contain uppercase letters, numbers, hyphens, and underscores.';
    END IF;

    -- Pre-insert check for clean user-facing error message
    IF EXISTS (SELECT 1 FROM public.stores WHERE UPPER(BTRIM(store_code)) = v_clean_store_code) THEN
        RAISE EXCEPTION 'STORE_CODE_EXISTS: Store code "%" is already in use by another store.', v_clean_store_code;
    END IF;

    -- Tax rate resolution (unconstrained numeric resolution -> range check -> round(2) -> cast numeric(5,2))
    IF p_default_tax_rate IS NOT NULL THEN
        v_raw_tax_rate := p_default_tax_rate;
    ELSIF v_meta ? 'default_tax_rate' AND v_meta->>'default_tax_rate' IS NOT NULL AND pg_catalog.btrim(v_meta->>'default_tax_rate') <> '' THEN
        BEGIN
            v_raw_tax_rate := (v_meta->>'default_tax_rate')::pg_catalog.numeric;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            RAISE EXCEPTION 'INVALID_TAX_RATE: Malformed tax rate "%" in user metadata. Value must be a valid numeric number.', v_meta->>'default_tax_rate';
        END;
    ELSE
        v_raw_tax_rate := 0.00;
    END IF;

    -- Validate range on original unrounded value before rounding or casting to numeric(5,2)
    IF v_raw_tax_rate < 0.00 OR v_raw_tax_rate > 100.00 THEN
        RAISE EXCEPTION 'INVALID_TAX_RATE: Default tax rate must be between 0.00 and 100.00 percent. Received %.', v_raw_tax_rate;
    END IF;

    -- Safely round to two decimal places and cast to numeric(5, 2)
    v_clean_tax_rate := pg_catalog.round(v_raw_tax_rate, 2)::pg_catalog.numeric(5, 2);

    v_clean_address := NULLIF(pg_catalog.btrim(COALESCE(p_store_address, v_meta->>'store_address', '')), '');

    -- 7. Atomic Creation Block with Unique Constraint Violation Interception
    BEGIN
        -- Insert new Store into public.stores
        INSERT INTO public.stores (
            name,
            store_code,
            address,
            default_tax_rate,
            is_active
        ) VALUES (
            v_clean_store_name,
            v_clean_store_code,
            v_clean_address,
            v_clean_tax_rate,
            TRUE
        )
        RETURNING id INTO v_store_id;

        -- Insert new Profile into public.profiles
        -- Role is strictly assigned server-side to 'store_manager'
        INSERT INTO public.profiles (
            id,
            store_id,
            role,
            full_name,
            email,
            is_active
        ) VALUES (
            v_user_id,
            v_store_id,
            'store_manager'::public.retailer_role_enum,
            v_user_full_name,
            pg_catalog.lower(pg_catalog.btrim(v_user_email)),
            TRUE
        );

    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
        -- Handle ONLY the exact verified unique constraint violations
        IF v_constraint_name IN ('stores_store_code_key', 'uq_stores_store_code_upper') THEN
            RAISE EXCEPTION 'STORE_CODE_EXISTS: Store code "%" was registered concurrently. Please choose a different code.', v_clean_store_code;
        ELSIF v_constraint_name = 'profiles_pkey' THEN
            RAISE EXCEPTION 'PROFILE_EXISTS: A profile was created concurrently for this account.';
        ELSE
            RAISE;
        END IF;
    END;

    -- 8. Post-provisioning Verification Assertion
    SELECT 
        p.id, 
        p.store_id, 
        p.role, 
        p.full_name, 
        p.email, 
        s.name AS store_name, 
        s.store_code, 
        s.default_tax_rate
    INTO v_profile_record
    FROM public.profiles p
    JOIN public.stores s ON s.id = p.store_id
    WHERE p.id = v_user_id AND p.is_active = TRUE;

    IF v_profile_record.id IS NULL THEN
        RAISE EXCEPTION 'POST_ACTIVATION_FAILED: Failed to verify linked profile and store record.';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'already_registered', false,
        'is_active', true,
        'message', 'Store and manager profile successfully registered.',
        'profile', pg_catalog.jsonb_build_object(
            'id', v_profile_record.id,
            'store_id', v_profile_record.store_id,
            'role', v_profile_record.role,
            'full_name', v_profile_record.full_name,
            'email', v_profile_record.email,
            'store_name', v_profile_record.store_name,
            'store_code', v_profile_record.store_code,
            'default_tax_rate', v_profile_record.default_tax_rate
        )
    );
END;
$$;

-- Security hardening
ALTER FUNCTION public.register_store_and_manager(pg_catalog.text, pg_catalog.text, pg_catalog.numeric, pg_catalog.text, pg_catalog.text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.register_store_and_manager(pg_catalog.text, pg_catalog.text, pg_catalog.numeric, pg_catalog.text, pg_catalog.text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_store_and_manager(pg_catalog.text, pg_catalog.text, pg_catalog.numeric, pg_catalog.text, pg_catalog.text) TO authenticated;

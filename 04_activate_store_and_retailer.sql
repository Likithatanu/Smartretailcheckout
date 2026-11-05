-- =============================================================================
-- AI SMART RETAIL CHECKOUT — PHASE 3: STORE & RETAILER ACTIVATION SCRIPT
-- =============================================================================
-- WORKSPACE: C:\Users\likit\OneDrive\Desktop\smartretailecheckout
-- 
-- PURPOSE:
-- Prepares the Supabase project for its first real retailer login.
-- This script is reviewed and designed for manual administrator execution
-- in the Supabase SQL Editor (as postgres / superuser).
--
-- SAFETY & INTEGRITY GUARANTEES:
-- 1. Strictly read-only against auth.users: Does not mutate auth.users or confirmation timestamps.
-- 2. Requires the retailer to already exist in auth.users AND have email_confirmed_at IS NOT NULL.
-- 3. Strict uniqueness: Stops with an error if the store code or user profile already exists.
--    No ON CONFLICT DO UPDATE (prevents silent reassignment or unauthorized role elevation).
-- 4. Validates all required inputs are non-empty and non-placeholder.
-- 5. No invented business data: Placeholders are explicitly marked for administrator input.
-- 6. Assigns 'store_manager' role exclusively to this explicitly designated retailer.
-- 7. Fully transactional (BEGIN / COMMIT) with post-execution verification output.
-- 8. 100% preserves existing Row Level Security (RLS) policies, triggers, and functions.
-- =============================================================================

SET search_path = public, extensions;

BEGIN;

DO $$
DECLARE
    -- =========================================================================
    -- CONFIGURATION PARAMETERS (SUPPLY REAL BUSINESS VALUES BEFORE EXECUTING)
    -- =========================================================================
    v_retailer_email     TEXT          := 'REPLACE_WITH_RETAILER_EMAIL';      -- Real email registered in Supabase Auth
    v_retailer_full_name TEXT          := 'REPLACE_WITH_RETAILER_FULL_NAME';  -- Real full name of the retailer
    v_store_name         TEXT          := 'REPLACE_WITH_STORE_NAME';          -- Real registered store name
    v_store_code         TEXT          := 'REPLACE_WITH_STORE_CODE';          -- Unique store code (e.g., 'STORE_BLR_01')
    v_store_address      TEXT          := NULL;                               -- Optional: Address string or NULL
    v_default_tax_rate   NUMERIC(5, 2) := 5.00;                               -- Default tax rate % (e.g., 5.00 for 5% GST)
    -- =========================================================================

    v_user_id             UUID;
    v_email_confirmed_at  TIMESTAMPTZ;
    v_store_id            UUID;
    v_clean_address       TEXT;
    v_verified_profile    RECORD;
BEGIN
    -- 1. Validate that required configuration parameters are not left as placeholders or empty
    IF TRIM(COALESCE(v_retailer_email, '')) = '' OR v_retailer_email = 'REPLACE_WITH_RETAILER_EMAIL' THEN
        RAISE EXCEPTION 'CONFIGURATION ERROR: v_retailer_email must be set to a real retailer email address.';
    END IF;

    IF v_retailer_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
        RAISE EXCEPTION 'CONFIGURATION ERROR: v_retailer_email "%" is not a valid email address format.', v_retailer_email;
    END IF;

    IF TRIM(COALESCE(v_retailer_full_name, '')) = '' OR v_retailer_full_name = 'REPLACE_WITH_RETAILER_FULL_NAME' THEN
        RAISE EXCEPTION 'CONFIGURATION ERROR: v_retailer_full_name must be set to the retailer''s real name.';
    END IF;

    IF TRIM(COALESCE(v_store_name, '')) = '' OR v_store_name = 'REPLACE_WITH_STORE_NAME' THEN
        RAISE EXCEPTION 'CONFIGURATION ERROR: v_store_name must be set to a real store name.';
    END IF;

    IF TRIM(COALESCE(v_store_code, '')) = '' OR v_store_code = 'REPLACE_WITH_STORE_CODE' THEN
        RAISE EXCEPTION 'CONFIGURATION ERROR: v_store_code must be set to a unique store identifier.';
    END IF;

    IF v_default_tax_rate IS NULL OR v_default_tax_rate < 0.00 OR v_default_tax_rate > 100.00 THEN
        RAISE EXCEPTION 'CONFIGURATION ERROR: v_default_tax_rate (%) must be between 0.00 and 100.00 percent.', v_default_tax_rate;
    END IF;

    v_clean_address := NULLIF(TRIM(COALESCE(v_store_address, '')), '');

    -- 2. Read-only validation of retailer user in auth.users (NO direct writes to auth.users)
    SELECT id, email_confirmed_at
    INTO v_user_id, v_email_confirmed_at
    FROM auth.users
    WHERE LOWER(email) = LOWER(TRIM(v_retailer_email));

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'USER NOT FOUND: Retailer email "%" does not exist in auth.users. Please create this user first in the Supabase Dashboard under Authentication -> Users (toggle "Auto Confirm User" to ON).', v_retailer_email;
    END IF;

    IF v_email_confirmed_at IS NULL THEN
        RAISE EXCEPTION 'EMAIL NOT CONFIRMED: User "%" exists in auth.users (ID: %), but email_confirmed_at is NULL. Please toggle "Auto Confirm User" to ON in the Supabase Dashboard or confirm the user email before activating this store profile.', v_retailer_email, v_user_id;
    END IF;

    -- 3. Strict uniqueness check on store_code (NO ON CONFLICT DO UPDATE)
    IF EXISTS (
        SELECT 1 FROM public.stores WHERE UPPER(store_code) = UPPER(TRIM(v_store_code))
    ) THEN
        RAISE EXCEPTION 'STORE CONFLICT: A store with store_code "%" already exists in public.stores. Stopping to prevent unauthorized overwrite.', UPPER(TRIM(v_store_code));
    END IF;

    -- 4. Strict uniqueness check on retailer profile (NO ON CONFLICT DO UPDATE)
    IF EXISTS (
        SELECT 1 FROM public.profiles WHERE id = v_user_id
    ) THEN
        RAISE EXCEPTION 'PROFILE CONFLICT: A profile already exists for Auth user "%" (ID: %). Stopping to prevent unauthorized store reassignment or role elevation.', v_retailer_email, v_user_id;
    END IF;

    -- 5. Insert new Store into public.stores
    INSERT INTO public.stores (
        name,
        store_code,
        address,
        default_tax_rate,
        is_active
    ) VALUES (
        TRIM(v_store_name),
        UPPER(TRIM(v_store_code)),
        v_clean_address,
        v_default_tax_rate,
        TRUE
    )
    RETURNING id INTO v_store_id;

    -- 6. Insert new Retailer Profile into public.profiles
    -- Assigning 'store_manager' role grants authority for register operations, product catalog management, and stock adjustments
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
        'store_manager',
        TRIM(v_retailer_full_name),
        LOWER(TRIM(v_retailer_email)),
        TRUE
    );

    -- 7. Verification assertion: Confirm that store and profile linkage resolves cleanly under RLS logic
    SELECT 
        p.id, 
        p.store_id, 
        p.role, 
        p.full_name, 
        p.email, 
        s.name AS store_name, 
        s.store_code, 
        s.default_tax_rate
    INTO v_verified_profile
    FROM public.profiles p
    JOIN public.stores s ON s.id = p.store_id
    WHERE p.id = v_user_id 
      AND p.is_active = TRUE 
      AND s.is_active = TRUE;

    IF v_verified_profile.id IS NULL THEN
        RAISE EXCEPTION 'POST-ACTIVATION CHECK FAILED: Profile and Store linkage could not be verified in database.';
    END IF;

    -- 8. Output clear verification results
    RAISE NOTICE '=============================================================================';
    RAISE NOTICE 'STORE & RETAILER ACTIVATION SUCCESSFUL';
    RAISE NOTICE '=============================================================================';
    RAISE NOTICE 'Store ID:           %', v_verified_profile.store_id;
    RAISE NOTICE 'Store Name:         %', v_verified_profile.store_name;
    RAISE NOTICE 'Store Code:         %', v_verified_profile.store_code;
    RAISE NOTICE 'Default Tax Rate:   %% %', v_verified_profile.default_tax_rate;
    RAISE NOTICE 'Retailer User ID:   %', v_verified_profile.id;
    RAISE NOTICE 'Retailer Name:      %', v_verified_profile.full_name;
    RAISE NOTICE 'Retailer Email:     %', v_verified_profile.email;
    RAISE NOTICE 'Assigned Role:      %', v_verified_profile.role;
    RAISE NOTICE '=============================================================================';
END;
$$;

COMMIT;

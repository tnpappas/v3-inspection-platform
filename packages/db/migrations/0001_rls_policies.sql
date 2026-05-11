-- 0001_rls_policies.sql
--
-- Row-level security per security spec S1 (business isolation) and S9 (account isolation).
--
-- Strategy:
--   - Two helper functions read PostgreSQL session variables that the API
--     middleware sets per request:
--       * app.current_account_id   (uuid)   the requester's account
--       * app.user_business_ids    (text)   comma-separated uuids of businesses
--                                           the requester belongs to within that account
--   - Both functions fail-closed: missing/empty session var means policies see
--     NULL/empty and return zero rows.
--   - Every account-scoped or business-scoped table gets ENABLE + FORCE RLS.
--     FORCE applies RLS even to table owners, which matters on Neon where the
--     application connection typically owns its tables.
--   - System reference tables (permissions, permission_groups,
--     permission_group_members) stay unrestricted; their content is product-
--     level reference data, not per-account.
--
-- Application contract:
--   Every authenticated request runs:
--     SET LOCAL app.current_account_id = '<uuid>';
--     SET LOCAL app.user_business_ids = '<uuid>,<uuid>,...';
--   before issuing any business query. The RLS context middleware in
--   apps/api/src/middleware/rls-context.ts owns this setup.

-- =============================================================================
-- Helper functions
-- =============================================================================

CREATE OR REPLACE FUNCTION app_current_account_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.current_account_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_user_business_ids() RETURNS uuid[]
  LANGUAGE sql STABLE
  AS $$
    SELECT CASE
      WHEN current_setting('app.user_business_ids', true) IS NULL
        OR current_setting('app.user_business_ids', true) = ''
      THEN ARRAY[]::uuid[]
      ELSE string_to_array(current_setting('app.user_business_ids', true), ',')::uuid[]
    END
  $$;

COMMENT ON FUNCTION app_current_account_id() IS
  'Returns the requesting users account_id from session var app.current_account_id, NULL if unset.';

COMMENT ON FUNCTION app_user_business_ids() IS
  'Returns the requesting users accessible business UUIDs from session var app.user_business_ids, empty array if unset.';

-- =============================================================================
-- Tier 1: account-scoped tables (filter by account_id)
-- =============================================================================

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY accounts_self_only ON accounts USING (id = app_current_account_id());

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY businesses_account_isolation ON businesses USING (account_id = app_current_account_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_account_isolation ON users USING (account_id = app_current_account_id());

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY customers_account_isolation ON customers USING (account_id = app_current_account_id());

ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties FORCE ROW LEVEL SECURITY;
CREATE POLICY properties_account_isolation ON properties USING (account_id = app_current_account_id());

ALTER TABLE transaction_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_participants FORCE ROW LEVEL SECURITY;
CREATE POLICY transaction_participants_account_isolation ON transaction_participants
  USING (account_id = app_current_account_id());

ALTER TABLE agencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE agencies FORCE ROW LEVEL SECURITY;
CREATE POLICY agencies_account_isolation ON agencies USING (account_id = app_current_account_id());

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_account_isolation ON audit_log USING (account_id = app_current_account_id());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_account_isolation ON role_permissions
  USING (account_id = app_current_account_id());

-- =============================================================================
-- Tier 2: account-scoped via user FK
-- =============================================================================

ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY user_credentials_account_isolation ON user_credentials USING (
  user_id IN (SELECT id FROM users WHERE account_id = app_current_account_id())
);

ALTER TABLE user_security ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_security FORCE ROW LEVEL SECURITY;
CREATE POLICY user_security_account_isolation ON user_security USING (
  user_id IN (SELECT id FROM users WHERE account_id = app_current_account_id())
);

ALTER TABLE user_mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_factors FORCE ROW LEVEL SECURITY;
CREATE POLICY user_mfa_factors_account_isolation ON user_mfa_factors USING (
  user_id IN (SELECT id FROM users WHERE account_id = app_current_account_id())
);

ALTER TABLE user_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permission_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY user_permission_overrides_account_isolation ON user_permission_overrides USING (
  user_id IN (SELECT id FROM users WHERE account_id = app_current_account_id())
);

-- =============================================================================
-- Tier 3: business-scoped tables (filter by business_id)
-- =============================================================================

ALTER TABLE user_businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY user_businesses_business_isolation ON user_businesses
  USING (business_id = ANY(app_user_business_ids()));

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY user_roles_business_isolation ON user_roles
  USING (business_id = ANY(app_user_business_ids()));

ALTER TABLE customer_businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_businesses_business_isolation ON customer_businesses
  USING (business_id = ANY(app_user_business_ids()));

ALTER TABLE property_businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY property_businesses_business_isolation ON property_businesses
  USING (business_id = ANY(app_user_business_ids()));

ALTER TABLE agency_businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY agency_businesses_business_isolation ON agency_businesses
  USING (business_id = ANY(app_user_business_ids()));

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE services FORCE ROW LEVEL SECURITY;
CREATE POLICY services_business_isolation ON services
  USING (business_id = ANY(app_user_business_ids()));

ALTER TABLE technician_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_hours FORCE ROW LEVEL SECURITY;
CREATE POLICY technician_hours_business_isolation ON technician_hours
  USING (business_id = ANY(app_user_business_ids()));

ALTER TABLE technician_time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_time_off FORCE ROW LEVEL SECURITY;
CREATE POLICY technician_time_off_business_isolation ON technician_time_off
  USING (business_id = ANY(app_user_business_ids()));

ALTER TABLE technician_zips ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_zips FORCE ROW LEVEL SECURITY;
CREATE POLICY technician_zips_business_isolation ON technician_zips
  USING (business_id = ANY(app_user_business_ids()));

ALTER TABLE technician_service_durations ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_service_durations FORCE ROW LEVEL SECURITY;
CREATE POLICY technician_service_durations_business_isolation ON technician_service_durations
  USING (business_id = ANY(app_user_business_ids()));

ALTER TABLE inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspections FORCE ROW LEVEL SECURITY;
CREATE POLICY inspections_business_isolation ON inspections
  USING (business_id = ANY(app_user_business_ids()));

-- =============================================================================
-- Tier 4: business-scoped via inspection FK
-- =============================================================================

ALTER TABLE inspection_inspectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_inspectors FORCE ROW LEVEL SECURITY;
CREATE POLICY inspection_inspectors_isolation ON inspection_inspectors USING (
  inspection_id IN (SELECT id FROM inspections WHERE business_id = ANY(app_user_business_ids()))
);

ALTER TABLE inspection_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_participants FORCE ROW LEVEL SECURITY;
CREATE POLICY inspection_participants_isolation ON inspection_participants USING (
  inspection_id IN (SELECT id FROM inspections WHERE business_id = ANY(app_user_business_ids()))
);

ALTER TABLE inspection_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_services FORCE ROW LEVEL SECURITY;
CREATE POLICY inspection_services_isolation ON inspection_services USING (
  inspection_id IN (SELECT id FROM inspections WHERE business_id = ANY(app_user_business_ids()))
);

ALTER TABLE inspection_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY inspection_notes_isolation ON inspection_notes USING (
  inspection_id IN (SELECT id FROM inspections WHERE business_id = ANY(app_user_business_ids()))
);

ALTER TABLE reschedule_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE reschedule_history FORCE ROW LEVEL SECURITY;
CREATE POLICY reschedule_history_isolation ON reschedule_history USING (
  inspection_id IN (SELECT id FROM inspections WHERE business_id = ANY(app_user_business_ids()))
);

-- =============================================================================
-- Tier 5: account-scoped via customer FK
-- =============================================================================

ALTER TABLE customer_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_properties FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_properties_isolation ON customer_properties USING (
  customer_id IN (SELECT id FROM customers WHERE account_id = app_current_account_id())
);

-- =============================================================================
-- System reference tables: no RLS
-- permissions, permission_groups, permission_group_members are product-level
-- reference data shared across all accounts. The catalog is identical for every
-- tenant; per-account customization happens via role_permissions (RLS above)
-- and user_permission_overrides (RLS above).
-- =============================================================================

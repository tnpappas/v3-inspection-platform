CREATE TYPE "public"."account_status" AS ENUM('active', 'suspended', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('create', 'update', 'delete', 'view', 'release', 'override', 'reschedule', 'cancel', 'login', 'logout', 'read_sensitive', 'export');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'denied', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."booking_source" AS ENUM('dispatcher', 'realtor_portal', 'client_booking', 'phone', 'email', 'api');--> statement-breakpoint
CREATE TYPE "public"."business_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."business_type" AS ENUM('inspection', 'pool', 'pest', 'other');--> statement-breakpoint
CREATE TYPE "public"."contact_relationship_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."inspection_status" AS ENUM('scheduled', 'confirmed', 'en_route', 'in_progress', 'completed', 'cancelled', 'no_show', 'on_hold');--> statement-breakpoint
CREATE TYPE "public"."inspector_on_inspection_role" AS ENUM('primary', 'secondary');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('unpaid', 'partial', 'paid', 'refunded', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."permission_effect" AS ENUM('grant', 'deny');--> statement-breakpoint
CREATE TYPE "public"."qa_status" AS ENUM('not_reviewed', 'in_review', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('owner', 'operations_manager', 'dispatcher', 'technician', 'client_success', 'bookkeeper', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."role_in_transaction" AS ENUM('buyer_agent', 'listing_agent', 'transaction_coordinator', 'escrow_officer', 'insurance_agent', 'lender', 'attorney', 'seller', 'other');--> statement-breakpoint
CREATE TYPE "public"."signature_status" AS ENUM('unsigned', 'signed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'inactive', 'invited');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"plan_tier" varchar(50) DEFAULT 'internal',
	"billing_email" varchar(255),
	"billing_name" varchar(255),
	"billing_address1" text,
	"billing_address2" text,
	"billing_city" varchar(100),
	"billing_state" varchar(2),
	"billing_zip" varchar(20),
	"billing_country" varchar(2) DEFAULT 'US',
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"last_modified_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"delete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "agencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"phone" varchar(50),
	"email" varchar(255),
	"address" text,
	"city" varchar(100),
	"state" varchar(2),
	"zip" varchar(20),
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"isn_source_id" uuid,
	"created_by" uuid NOT NULL,
	"last_modified_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"delete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agency_businesses" (
	"agency_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "contact_relationship_status" DEFAULT 'active' NOT NULL,
	CONSTRAINT "agency_businesses_agency_id_business_id_pk" PRIMARY KEY("agency_id","business_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"business_id" uuid,
	"user_id" uuid,
	"session_id" varchar(64),
	"request_id" uuid,
	"action" "audit_action" NOT NULL,
	"outcome" "audit_outcome" DEFAULT 'success' NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" uuid,
	"changes" jsonb,
	"changes_size" integer,
	"ip_address" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_entity_type_check" CHECK (entity_type IN (
      'account','business','user','user_credential','user_security','user_mfa_factor','user_business','user_role',
      'permission','permission_group','permission_group_member','role_permission','user_permission_override',
      'customer','property','customer_business','property_business','customer_property','transaction_participant','agency','agency_business',
      'service','technician_hours','technician_time_off','technician_zip','technician_service_duration',
      'inspection','inspection_inspector','inspection_participant','inspection_service','inspection_note','reschedule_history',
      'login_attempt','session','export_job','system'
    ))
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"type" "business_type" NOT NULL,
	"status" "business_status" DEFAULT 'active' NOT NULL,
	"logo_url" varchar(500),
	"primary_color" varchar(16),
	"address1" text,
	"address2" text,
	"city" varchar(100),
	"state" varchar(2),
	"zip" varchar(20),
	"phone" varchar(50),
	"email" varchar(255),
	"website" varchar(255),
	"display_order" integer DEFAULT 0 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"last_modified_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"delete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_businesses" (
	"customer_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "contact_relationship_status" DEFAULT 'active' NOT NULL,
	CONSTRAINT "customer_businesses_customer_id_business_id_pk" PRIMARY KEY("customer_id","business_id")
);
--> statement-breakpoint
CREATE TABLE "customer_properties" (
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"relationship" varchar(50),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_properties_customer_id_property_id_pk" PRIMARY KEY("customer_id","property_id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"display_name" varchar(200) NOT NULL,
	"email" varchar(255),
	"phone_mobile" varchar(50),
	"phone_home" varchar(50),
	"phone_work" varchar(50),
	"address1" text,
	"address2" text,
	"city" varchar(100),
	"state" varchar(2),
	"zip" varchar(20),
	"notes" text,
	"sms_opt_in" boolean DEFAULT false NOT NULL,
	"email_opt_in" boolean DEFAULT true NOT NULL,
	"isn_source_id" uuid,
	"isn_source_type" varchar(50),
	"status" "customer_status" DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"delete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspection_inspectors" (
	"inspection_id" uuid NOT NULL,
	"inspector_id" uuid NOT NULL,
	"role" "inspector_on_inspection_role" DEFAULT 'secondary' NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" uuid,
	CONSTRAINT "inspection_inspectors_inspection_id_inspector_id_pk" PRIMARY KEY("inspection_id","inspector_id")
);
--> statement-breakpoint
CREATE TABLE "inspection_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inspection_id" uuid NOT NULL,
	"author_id" uuid,
	"note_type" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"is_internal" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"isn_source_id" uuid
);
--> statement-breakpoint
CREATE TABLE "inspection_participants" (
	"inspection_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"role_in_transaction" "role_in_transaction" NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspection_participants_inspection_id_participant_id_role_in_transaction_pk" PRIMARY KEY("inspection_id","participant_id","role_in_transaction")
);
--> statement-breakpoint
CREATE TABLE "inspection_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inspection_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"fee" numeric(10, 2) NOT NULL,
	"duration_minutes" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inspections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"order_number" varchar(50) NOT NULL,
	"isn_source_id" uuid,
	"isn_report_number" varchar(50),
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 180 NOT NULL,
	"lead_inspector_id" uuid,
	"customer_id" uuid,
	"property_id" uuid,
	"bill_to_participant_id" uuid,
	"status" "inspection_status" DEFAULT 'scheduled' NOT NULL,
	"payment_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"signature_status" "signature_status" DEFAULT 'unsigned' NOT NULL,
	"qa_status" "qa_status" DEFAULT 'not_reviewed' NOT NULL,
	"report_released" boolean DEFAULT false NOT NULL,
	"report_released_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"initial_completed_at" timestamp with time zone,
	"initial_completed_by" uuid,
	"fee_amount" numeric(10, 2) NOT NULL,
	"special_instructions" text,
	"internal_notes" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"completed_at" timestamp with time zone,
	"source" "booking_source" DEFAULT 'dispatcher' NOT NULL,
	"source_participant_id" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"delete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "permission_group_members" (
	"group_key" varchar(100) NOT NULL,
	"permission_key" varchar(100) NOT NULL,
	CONSTRAINT "permission_group_members_group_key_permission_key_pk" PRIMARY KEY("group_key","permission_key")
);
--> statement-breakpoint
CREATE TABLE "permission_groups" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"category" varchar(50) NOT NULL,
	"description" text NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"address1" text NOT NULL,
	"address2" text,
	"city" varchar(100) NOT NULL,
	"state" varchar(2) NOT NULL,
	"zip" varchar(20) NOT NULL,
	"county" varchar(100),
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"year_built" integer,
	"square_feet" integer,
	"bedrooms" integer,
	"bathrooms" numeric(4, 1),
	"foundation" varchar(100),
	"occupancy" varchar(100),
	"property_type" varchar(100),
	"gate_code" varchar(50),
	"notes" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"delete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_businesses" (
	"property_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "contact_relationship_status" DEFAULT 'active' NOT NULL,
	CONSTRAINT "property_businesses_property_id_business_id_pk" PRIMARY KEY("property_id","business_id")
);
--> statement-breakpoint
CREATE TABLE "reschedule_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inspection_id" uuid NOT NULL,
	"previous_scheduled_at" timestamp with time zone NOT NULL,
	"new_scheduled_at" timestamp with time zone NOT NULL,
	"previous_inspector_id" uuid,
	"new_inspector_id" uuid,
	"reason" text,
	"initiated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"account_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"permission_key" varchar(100),
	"group_key" varchar(100),
	"configured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"configured_by" uuid,
	CONSTRAINT "role_permissions_account_id_role_permission_key_group_key_pk" PRIMARY KEY("account_id","role","permission_key","group_key"),
	CONSTRAINT "role_permissions_exactly_one_target" CHECK ((permission_key IS NULL) <> (group_key IS NULL))
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"public_description" text,
	"category" varchar(100),
	"base_fee" numeric(10, 2) NOT NULL,
	"default_duration_minutes" integer DEFAULT 180 NOT NULL,
	"sequence" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"isn_source_id" uuid,
	"isn_sid" integer,
	"ancillary" boolean DEFAULT false NOT NULL,
	"visible_to_dispatcher" boolean DEFAULT true NOT NULL,
	"visible_online_booking" boolean DEFAULT false NOT NULL,
	"is_pac" boolean DEFAULT false NOT NULL,
	"modifiers" jsonb,
	"questions" jsonb,
	"created_by" uuid NOT NULL,
	"last_modified_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "technician_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"day_of_week" integer NOT NULL,
	"start_time" varchar(5) NOT NULL,
	"end_time" varchar(5) NOT NULL,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"last_modified_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "technician_service_durations" (
	"user_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"duration_minutes" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"last_modified_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technician_service_durations_user_id_service_id_pk" PRIMARY KEY("user_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "technician_time_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_by" uuid NOT NULL,
	"last_modified_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "technician_zips" (
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"zip" varchar(20) NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"last_modified_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technician_zips_user_id_business_id_zip_pk" PRIMARY KEY("user_id","business_id","zip")
);
--> statement-breakpoint
CREATE TABLE "transaction_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"agency_id" uuid,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"display_name" varchar(200) NOT NULL,
	"email" varchar(255),
	"phone" varchar(50),
	"mobile" varchar(50),
	"primary_role" "role_in_transaction",
	"notes" text,
	"isn_source_id" uuid,
	"isn_source_type" varchar(50),
	"status" "contact_relationship_status" DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"delete_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_businesses" (
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"status" "membership_status" DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_businesses_user_id_business_id_pk" PRIMARY KEY("user_id","business_id")
);
--> statement-breakpoint
CREATE TABLE "user_credentials" (
	"user_id" uuid NOT NULL,
	"kind" varchar(50) NOT NULL,
	"secret" text,
	"external_subject" varchar(255),
	"rotated_at" timestamp with time zone,
	"require_rotation" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_credentials_user_id_kind_pk" PRIMARY KEY("user_id","kind")
);
--> statement-breakpoint
CREATE TABLE "user_mfa_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" varchar(50) NOT NULL,
	"label" varchar(100),
	"secret" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_permission_overrides" (
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"permission_key" varchar(100),
	"group_key" varchar(100),
	"effect" "permission_effect" NOT NULL,
	"reason" text,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "user_permission_overrides_user_id_business_id_permission_key_group_key_effect_pk" PRIMARY KEY("user_id","business_id","permission_key","group_key","effect"),
	CONSTRAINT "user_permission_overrides_exactly_one_target" CHECK ((permission_key IS NULL) <> (group_key IS NULL))
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" uuid,
	"expires_at" timestamp with time zone,
	"expiration_reason" text,
	CONSTRAINT "user_roles_user_id_business_id_role_pk" PRIMARY KEY("user_id","business_id","role")
);
--> statement-breakpoint
CREATE TABLE "user_security" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"last_failed_login_at" timestamp with time zone,
	"last_failed_login_ip" varchar(64),
	"last_successful_login_at" timestamp with time zone,
	"last_successful_login_ip" varchar(64),
	"last_successful_user_agent" text,
	"locked_until" timestamp with time zone,
	"locked_reason" text,
	"require_password_reset" boolean DEFAULT false NOT NULL,
	"password_reset_token_hash" varchar(255),
	"password_reset_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"email_verified_at" timestamp with time zone,
	"username" varchar(100),
	"first_name" varchar(100),
	"last_name" varchar(100),
	"display_name" varchar(200) NOT NULL,
	"phone" varchar(50),
	"mobile" varchar(50),
	"fax" varchar(50),
	"address1" text,
	"address2" text,
	"city" varchar(100),
	"state" varchar(2),
	"zip" varchar(20),
	"county" varchar(100),
	"license" varchar(100),
	"license_type" varchar(100),
	"bio" text,
	"photo_url" varchar(500),
	"sms_opt_in" boolean DEFAULT false NOT NULL,
	"email_opt_in" boolean DEFAULT true NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"isn_source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_last_modified_by_users_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agencies" ADD CONSTRAINT "agencies_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agencies" ADD CONSTRAINT "agencies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agencies" ADD CONSTRAINT "agencies_last_modified_by_users_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agencies" ADD CONSTRAINT "agencies_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_businesses" ADD CONSTRAINT "agency_businesses_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agency_businesses" ADD CONSTRAINT "agency_businesses_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_last_modified_by_users_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_businesses" ADD CONSTRAINT "customer_businesses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_businesses" ADD CONSTRAINT "customer_businesses_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_properties" ADD CONSTRAINT "customer_properties_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_properties" ADD CONSTRAINT "customer_properties_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_inspectors" ADD CONSTRAINT "inspection_inspectors_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_inspectors" ADD CONSTRAINT "inspection_inspectors_inspector_id_users_id_fk" FOREIGN KEY ("inspector_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_inspectors" ADD CONSTRAINT "inspection_inspectors_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_notes" ADD CONSTRAINT "inspection_notes_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_notes" ADD CONSTRAINT "inspection_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_participants" ADD CONSTRAINT "inspection_participants_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_participants" ADD CONSTRAINT "inspection_participants_participant_id_transaction_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."transaction_participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_services" ADD CONSTRAINT "inspection_services_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_services" ADD CONSTRAINT "inspection_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_lead_inspector_id_users_id_fk" FOREIGN KEY ("lead_inspector_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_bill_to_participant_id_transaction_participants_id_fk" FOREIGN KEY ("bill_to_participant_id") REFERENCES "public"."transaction_participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_initial_completed_by_users_id_fk" FOREIGN KEY ("initial_completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_source_participant_id_transaction_participants_id_fk" FOREIGN KEY ("source_participant_id") REFERENCES "public"."transaction_participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_group_members" ADD CONSTRAINT "permission_group_members_group_key_permission_groups_key_fk" FOREIGN KEY ("group_key") REFERENCES "public"."permission_groups"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_group_members" ADD CONSTRAINT "permission_group_members_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_businesses" ADD CONSTRAINT "property_businesses_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_businesses" ADD CONSTRAINT "property_businesses_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reschedule_history" ADD CONSTRAINT "reschedule_history_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reschedule_history" ADD CONSTRAINT "reschedule_history_previous_inspector_id_users_id_fk" FOREIGN KEY ("previous_inspector_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reschedule_history" ADD CONSTRAINT "reschedule_history_new_inspector_id_users_id_fk" FOREIGN KEY ("new_inspector_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reschedule_history" ADD CONSTRAINT "reschedule_history_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_group_key_permission_groups_key_fk" FOREIGN KEY ("group_key") REFERENCES "public"."permission_groups"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_configured_by_users_id_fk" FOREIGN KEY ("configured_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_last_modified_by_users_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_hours" ADD CONSTRAINT "technician_hours_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_hours" ADD CONSTRAINT "technician_hours_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_hours" ADD CONSTRAINT "technician_hours_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_hours" ADD CONSTRAINT "technician_hours_last_modified_by_users_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_service_durations" ADD CONSTRAINT "technician_service_durations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_service_durations" ADD CONSTRAINT "technician_service_durations_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_service_durations" ADD CONSTRAINT "technician_service_durations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_service_durations" ADD CONSTRAINT "technician_service_durations_last_modified_by_users_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_time_off" ADD CONSTRAINT "technician_time_off_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_time_off" ADD CONSTRAINT "technician_time_off_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_time_off" ADD CONSTRAINT "technician_time_off_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_time_off" ADD CONSTRAINT "technician_time_off_last_modified_by_users_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_zips" ADD CONSTRAINT "technician_zips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_zips" ADD CONSTRAINT "technician_zips_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_zips" ADD CONSTRAINT "technician_zips_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_zips" ADD CONSTRAINT "technician_zips_last_modified_by_users_id_fk" FOREIGN KEY ("last_modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_participants" ADD CONSTRAINT "transaction_participants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_participants" ADD CONSTRAINT "transaction_participants_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_participants" ADD CONSTRAINT "transaction_participants_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_businesses" ADD CONSTRAINT "user_businesses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_businesses" ADD CONSTRAINT "user_businesses_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa_factors" ADD CONSTRAINT "user_mfa_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_group_key_permission_groups_key_fk" FOREIGN KEY ("group_key") REFERENCES "public"."permission_groups"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_security" ADD CONSTRAINT "user_security_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_status_idx" ON "accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "accounts_deleted_at_idx" ON "accounts" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "agencies_account_idx" ON "agencies" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "agencies_account_name_lower_idx" ON "agencies" USING btree ("account_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "agencies_account_isn_source_unique" ON "agencies" USING btree ("account_id","isn_source_id") WHERE "agencies"."isn_source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agencies_deleted_at_idx" ON "agencies" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "agency_businesses_business_idx" ON "agency_businesses" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "audit_log_account_created_at_idx" ON "audit_log" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_user_idx" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_business_created_at_idx" ON "audit_log" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_request_idx" ON "audit_log" USING btree ("request_id") WHERE "audit_log"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_log_session_idx" ON "audit_log" USING btree ("session_id") WHERE "audit_log"."session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "businesses_account_idx" ON "businesses" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "businesses_account_status_idx" ON "businesses" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_account_slug_unique" ON "businesses" USING btree ("account_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_account_display_order_unique" ON "businesses" USING btree ("account_id","display_order");--> statement-breakpoint
CREATE INDEX "businesses_deleted_at_idx" ON "businesses" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "customer_businesses_business_idx" ON "customer_businesses" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "customer_businesses_last_activity_idx" ON "customer_businesses" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX "customers_account_idx" ON "customers" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "customers_account_email_idx" ON "customers" USING btree ("account_id",lower("email"));--> statement-breakpoint
CREATE INDEX "customers_account_name_idx" ON "customers" USING btree ("account_id",lower("display_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "customers_account_isn_source_unique" ON "customers" USING btree ("account_id","isn_source_id") WHERE "customers"."isn_source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customers_deleted_at_idx" ON "customers" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "inspection_notes_inspection_idx" ON "inspection_notes" USING btree ("inspection_id");--> statement-breakpoint
CREATE INDEX "inspection_notes_inspection_date_idx" ON "inspection_notes" USING btree ("inspection_id","created_at");--> statement-breakpoint
CREATE INDEX "inspection_notes_author_idx" ON "inspection_notes" USING btree ("author_id") WHERE "inspection_notes"."author_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "inspection_participants_participant_idx" ON "inspection_participants" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "inspection_participants_role_idx" ON "inspection_participants" USING btree ("role_in_transaction");--> statement-breakpoint
CREATE INDEX "inspection_services_inspection_idx" ON "inspection_services" USING btree ("inspection_id");--> statement-breakpoint
CREATE INDEX "inspections_business_idx" ON "inspections" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "inspections_scheduled_at_idx" ON "inspections" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "inspections_lead_inspector_idx" ON "inspections" USING btree ("lead_inspector_id");--> statement-breakpoint
CREATE INDEX "inspections_status_idx" ON "inspections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inspections_customer_idx" ON "inspections" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "inspections_property_idx" ON "inspections" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "inspections_biz_status_scheduled_idx" ON "inspections" USING btree ("business_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX "inspections_biz_inspector_scheduled_idx" ON "inspections" USING btree ("business_id","lead_inspector_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "inspections_biz_customer_scheduled_idx" ON "inspections" USING btree ("business_id","customer_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "inspections_biz_property_scheduled_idx" ON "inspections" USING btree ("business_id","property_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inspections_biz_order_number_unique" ON "inspections" USING btree ("business_id","order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "inspections_biz_isn_source_unique" ON "inspections" USING btree ("business_id","isn_source_id") WHERE "inspections"."isn_source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "inspections_deleted_at_idx" ON "inspections" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "permission_group_members_permission_idx" ON "permission_group_members" USING btree ("permission_key");--> statement-breakpoint
CREATE INDEX "permission_groups_sensitive_idx" ON "permission_groups" USING btree ("sensitive") WHERE "permission_groups"."sensitive" = true;--> statement-breakpoint
CREATE INDEX "permissions_category_idx" ON "permissions" USING btree ("category");--> statement-breakpoint
CREATE INDEX "permissions_sensitive_idx" ON "permissions" USING btree ("sensitive") WHERE "permissions"."sensitive" = true;--> statement-breakpoint
CREATE INDEX "properties_account_idx" ON "properties" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "properties_account_zip_idx" ON "properties" USING btree ("account_id","zip");--> statement-breakpoint
CREATE INDEX "properties_account_addr_lower_idx" ON "properties" USING btree ("account_id",lower("address1"),"zip");--> statement-breakpoint
CREATE INDEX "properties_deleted_at_idx" ON "properties" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "property_businesses_business_idx" ON "property_businesses" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "reschedule_history_inspection_idx" ON "reschedule_history" USING btree ("inspection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reschedule_history_unique_reschedule_idx" ON "reschedule_history" USING btree ("inspection_id","previous_scheduled_at","new_scheduled_at");--> statement-breakpoint
CREATE INDEX "role_permissions_account_role_idx" ON "role_permissions" USING btree ("account_id","role");--> statement-breakpoint
CREATE INDEX "services_business_idx" ON "services" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "services_business_active_idx" ON "services" USING btree ("business_id","active");--> statement-breakpoint
CREATE INDEX "services_business_category_idx" ON "services" USING btree ("business_id","category") WHERE "services"."category" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "services_business_isn_source_unique" ON "services" USING btree ("business_id","isn_source_id") WHERE "services"."isn_source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "services_isn_sid_idx" ON "services" USING btree ("isn_sid") WHERE "services"."isn_sid" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "technician_hours_user_biz_idx" ON "technician_hours" USING btree ("user_id","business_id");--> statement-breakpoint
CREATE INDEX "technician_time_off_user_biz_idx" ON "technician_time_off" USING btree ("user_id","business_id");--> statement-breakpoint
CREATE INDEX "technician_time_off_window_idx" ON "technician_time_off" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "technician_zips_zip_biz_idx" ON "technician_zips" USING btree ("zip","business_id");--> statement-breakpoint
CREATE INDEX "tparticipants_account_idx" ON "transaction_participants" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "tparticipants_account_email_idx" ON "transaction_participants" USING btree ("account_id","email");--> statement-breakpoint
CREATE INDEX "tparticipants_account_agency_idx" ON "transaction_participants" USING btree ("account_id","agency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tparticipants_account_isn_source_unique" ON "transaction_participants" USING btree ("account_id","isn_source_id") WHERE "transaction_participants"."isn_source_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tparticipants_deleted_at_idx" ON "transaction_participants" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "user_businesses_business_idx" ON "user_businesses" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "user_credentials_user_idx" ON "user_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_credentials_kind_subject_unique" ON "user_credentials" USING btree ("kind","external_subject") WHERE "user_credentials"."external_subject" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_mfa_factors_user_idx" ON "user_mfa_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_mfa_factors_user_enabled_idx" ON "user_mfa_factors" USING btree ("user_id","enabled");--> statement-breakpoint
CREATE INDEX "user_permission_overrides_user_business_idx" ON "user_permission_overrides" USING btree ("user_id","business_id");--> statement-breakpoint
CREATE INDEX "user_permission_overrides_expires_idx" ON "user_permission_overrides" USING btree ("expires_at") WHERE "user_permission_overrides"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_roles_business_role_idx" ON "user_roles" USING btree ("business_id","role");--> statement-breakpoint
CREATE INDEX "user_roles_expires_at_idx" ON "user_roles" USING btree ("expires_at") WHERE "user_roles"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_security_locked_until_idx" ON "user_security" USING btree ("locked_until");--> statement-breakpoint
CREATE INDEX "users_account_idx" ON "users" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "users_account_status_idx" ON "users" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_account_email_unique" ON "users" USING btree ("account_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_account_isn_source_unique" ON "users" USING btree ("account_id","isn_source_id") WHERE "users"."isn_source_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_account_system_unique" ON "users" USING btree ("account_id") WHERE "users"."is_system" = true;
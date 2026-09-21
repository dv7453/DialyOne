CREATE TABLE "action_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"action_id" text NOT NULL,
	"playbook_id" text NOT NULL,
	"signal_id" text NOT NULL,
	"args" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text,
	"prompt" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"action_id" text NOT NULL,
	"playbook_id" text NOT NULL,
	"capability" text NOT NULL,
	"args" jsonb NOT NULL,
	"signal_id" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credentials_user_id_provider_uidx" UNIQUE("user_id","provider")
);
--> statement-breakpoint
CREATE TABLE "journal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"playbook_id" text,
	"signal_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "open_loops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"intent" text NOT NULL,
	"capability" text,
	"known_args" jsonb NOT NULL,
	"missing_args" jsonb NOT NULL,
	"due_at" timestamp with time zone,
	"source_channel" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler_state" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"last_run_at" timestamp with time zone,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "trust_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"playbook_id" text NOT NULL,
	"capability" text NOT NULL,
	"severity" text NOT NULL,
	"streak" integer DEFAULT 0 NOT NULL,
	"autonomy_granted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_ledger_user_playbook_capability_uidx" UNIQUE("user_id","playbook_id","capability")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	CONSTRAINT "auth_sessions_token_hash_uidx" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "login_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "login_tokens_token_hash_uidx" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "action_queue" ADD CONSTRAINT "action_queue_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal" ADD CONSTRAINT "journal_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "open_loops" ADD CONSTRAINT "open_loops_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler_state" ADD CONSTRAINT "scheduler_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_ledger" ADD CONSTRAINT "trust_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_queue_user_id_idx" ON "action_queue" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "action_queue_status_next_attempt_at_idx" ON "action_queue" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_user_id_idx" ON "agent_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "approvals_user_id_idx" ON "approvals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credentials_user_id_idx" ON "credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "journal_user_id_idx" ON "journal" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "journal_user_id_created_at_idx" ON "journal" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "open_loops_user_id_idx" ON "open_loops" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scheduler_state_user_id_idx" ON "scheduler_state" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trust_ledger_user_id_idx" ON "trust_ledger" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "login_tokens_email_idx" ON "login_tokens" USING btree ("email");--> statement-breakpoint
CREATE INDEX "login_tokens_user_id_idx" ON "login_tokens" USING btree ("user_id");
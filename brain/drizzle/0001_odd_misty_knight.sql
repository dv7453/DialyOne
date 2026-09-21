CREATE TABLE "spend_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" text NOT NULL,
	"reserved_nanos" bigint DEFAULT 0 NOT NULL,
	"spent_nanos" bigint DEFAULT 0 NOT NULL,
	"reserved_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_ledger_user_id_day_uidx" UNIQUE("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spend_ledger_user_id_idx" ON "spend_ledger" USING btree ("user_id");
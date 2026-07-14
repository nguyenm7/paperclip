ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "premise_exempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "premise_exempt_reason" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "premise_exempt_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "premise_exempt_by_user_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "stale_premise_alarmed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvals" ADD CONSTRAINT "approvals_premise_exempt_by_agent_id_agents_id_fk" FOREIGN KEY ("premise_exempt_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "premise_exempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "premise_exempt_reason" text;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "premise_exempt_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "premise_exempt_by_user_id" text;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "stale_premise_alarmed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_premise_exempt_by_agent_id_agents_id_fk" FOREIGN KEY ("premise_exempt_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

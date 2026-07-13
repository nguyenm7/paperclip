ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "decided_by_actor_source" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "withdrawn_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "withdrawn_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvals" ADD CONSTRAINT "approvals_withdrawn_by_agent_id_agents_id_fk" FOREIGN KEY ("withdrawn_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

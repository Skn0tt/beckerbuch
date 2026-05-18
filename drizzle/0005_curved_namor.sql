ALTER TABLE "flats" ADD COLUMN "dedup_input_hash" text;--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "dedup_groups" jsonb;--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "dedup_rejected_group_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "dedup_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "flats" ADD COLUMN "dedup_model" text;
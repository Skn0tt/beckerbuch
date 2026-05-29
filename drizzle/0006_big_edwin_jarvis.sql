ALTER TABLE "oauth_authorization_codes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_clients" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_tokens" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "oauth_authorization_codes" CASCADE;--> statement-breakpoint
DROP TABLE "oauth_clients" CASCADE;--> statement-breakpoint
DROP TABLE "oauth_tokens" CASCADE;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mcp_token" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_mcp_token_unique" UNIQUE("mcp_token");
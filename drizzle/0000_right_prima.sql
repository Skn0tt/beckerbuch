CREATE TABLE "flat_members" (
	"flat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flat_members_flat_id_user_id_pk" PRIMARY KEY("flat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "flats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"amount" numeric,
	"unit" text,
	"item" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"token" text PRIMARY KEY NOT NULL,
	"flat_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"used_by" uuid,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flat_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"target_quantity" integer NOT NULL,
	"designated_cook_id" uuid,
	"position" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalised_at" timestamp with time zone,
	"cooked_at" timestamp with time zone,
	"cooked_by" uuid,
	CONSTRAINT "recipe_instances_cooked_requires_finalised" CHECK ("recipe_instances"."cooked_at" is null or "recipe_instances"."finalised_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flat_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_quantity" integer NOT NULL,
	"base_quantity_unit" text NOT NULL,
	"source_url" text,
	"source_host" text,
	"photo_blob_key" text,
	"steps" text DEFAULT '' NOT NULL,
	"search_vector" "tsvector",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "flat_members" ADD CONSTRAINT "flat_members_flat_id_flats_id_fk" FOREIGN KEY ("flat_id") REFERENCES "public"."flats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flat_members" ADD CONSTRAINT "flat_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_flat_id_flats_id_fk" FOREIGN KEY ("flat_id") REFERENCES "public"."flats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_instances" ADD CONSTRAINT "recipe_instances_flat_id_flats_id_fk" FOREIGN KEY ("flat_id") REFERENCES "public"."flats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_instances" ADD CONSTRAINT "recipe_instances_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_instances" ADD CONSTRAINT "recipe_instances_designated_cook_id_users_id_fk" FOREIGN KEY ("designated_cook_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_instances" ADD CONSTRAINT "recipe_instances_cooked_by_users_id_fk" FOREIGN KEY ("cooked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_flat_id_flats_id_fk" FOREIGN KEY ("flat_id") REFERENCES "public"."flats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flat_members_one_per_user" ON "flat_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingredients_recipe_position" ON "ingredients" USING btree ("recipe_id","position");--> statement-breakpoint
CREATE INDEX "ingredients_item_trgm" ON "ingredients" USING gin ("item" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_instances_draft_position" ON "recipe_instances" USING btree ("flat_id","position") WHERE finalised_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_instances_in_stock_position" ON "recipe_instances" USING btree ("flat_id","position") WHERE finalised_at is not null and cooked_at is null;--> statement-breakpoint
CREATE INDEX "recipe_instances_draft_idx" ON "recipe_instances" USING btree ("flat_id") WHERE finalised_at is null;--> statement-breakpoint
CREATE INDEX "recipe_instances_in_stock_idx" ON "recipe_instances" USING btree ("flat_id") WHERE finalised_at is not null and cooked_at is null;--> statement-breakpoint
CREATE INDEX "recipe_instances_cooked_idx" ON "recipe_instances" USING btree ("flat_id",cooked_at desc) WHERE cooked_at is not null;--> statement-breakpoint
CREATE INDEX "recipes_flat_id_idx" ON "recipes" USING btree ("flat_id");--> statement-breakpoint
CREATE INDEX "recipes_fts" ON "recipes" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "recipes_name_trgm" ON "recipes" USING gin ("name" gin_trgm_ops);
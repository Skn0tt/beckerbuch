ALTER TABLE "ingredients" ADD COLUMN "search_vector" "tsvector";--> statement-breakpoint
UPDATE "ingredients" SET "search_vector" = to_tsvector('simple', unaccent(coalesce("item", '')));--> statement-breakpoint
CREATE INDEX "ingredients_fts" ON "ingredients" USING gin ("search_vector");

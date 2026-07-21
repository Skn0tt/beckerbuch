-- Re-backfill any NULL ingredient search vectors (e.g. if 0008's UPDATE
-- did not land on a preview DB) and ensure the FTS GIN index exists.
UPDATE "ingredients"
SET "search_vector" = to_tsvector('simple', unaccent(coalesce("item", '')))
WHERE "search_vector" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ingredients_fts" ON "ingredients" USING gin ("search_vector");

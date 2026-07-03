import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  primaryKey,
  uniqueIndex,
  index,
  customType,
  check,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/**
 * Dimensionless pgvector column. We deliberately do NOT fix the
 * dimension: different embedding models emit different lengths
 * (text-embedding-3-small = 1536, -3-large = 3072, …), so a
 * dimensionless column stores any of them and switching
 * DEDUP_EMBEDDING_MODEL needs no migration. Clustering happens in JS,
 * so we don't need a fixed-dimension ANN index.
 *
 * pgvector's text format is `[1,2,3]`, so we map to/from `number[]`
 * here and callers deal in plain arrays.
 */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value) as number[];
  },
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: citext("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  avatarBlobKey: text("avatar_blob_key"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DedupGroup = {
  /** Stable id for this group within the snapshot. */
  id: string;
  /** Display item name chosen for the group. */
  item: string;
  /** Canonical unit, or null for unitless / unmergeable. */
  unit: string | null;
  /** Summed amount in the canonical unit, or null. */
  amount: string | null;
  /** Pre-formatted text shown in the UI and emitted to JSON-LD. */
  displayText: string;
  /** Source ingredient lines that contributed to this group. */
  sources: {
    /** Stable per-snapshot source id (e.g. ingredient row id). */
    id: string;
    /** Original formatted text of the source line. */
    displayText: string;
    /** Recipe the source line came from. */
    recipeName: string;
  }[];
};

export const flats = pgTable("flats", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * Hash of the dedup input — used by the handoff loader to detect
   * staleness when recipes are edited after Finalise.
   */
  dedupInputHash: text("dedup_input_hash"),
  /** Snapshot of merged ingredient groups, computed at Finalise. */
  dedupGroups: jsonb("dedup_groups").$type<DedupGroup[]>(),
  /**
   * Per-group reject overrides — when a group id is in this list the
   * UI and JSON-LD render the original source lines instead of the
   * merged entry. Public write surface; see TECH.md.
   */
  dedupRejectedGroupIds: jsonb("dedup_rejected_group_ids")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  dedupGeneratedAt: timestamp("dedup_generated_at", { withTimezone: true }),
  /** Backend identifier — e.g. "openai:gpt-5-mini", "fake", "none". */
  dedupModel: text("dedup_model"),
});

export const flatMembers = pgTable(
  "flat_members",
  {
    flatId: uuid("flat_id")
      .notNull()
      .references(() => flats.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.flatId, t.userId] }),
    uniqueIndex("flat_members_one_per_user").on(t.userId),
  ],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const invites = pgTable("invites", {
  token: text("token").primaryKey(),
  flatId: uuid("flat_id")
    .notNull()
    .references(() => flats.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by").references(() => users.id),
  usedBy: uuid("used_by").references(() => users.id),
  usedAt: timestamp("used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const recipes = pgTable(
  "recipes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    flatId: uuid("flat_id")
      .notNull()
      .references(() => flats.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    baseQuantity: integer("base_quantity").notNull(),
    sourceUrl: text("source_url"),
    sourceHost: text("source_host"),
    photoBlobKey: text("photo_blob_key"),
    steps: text("steps").notNull().default(""),
    searchVector: tsvector("search_vector"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("recipes_flat_id_idx").on(t.flatId),
    index("recipes_fts").using("gin", t.searchVector),
    index("recipes_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
    check(
      "recipes_base_quantity_range",
      sql`${t.baseQuantity} >= 1 and ${t.baseQuantity} <= 1000`,
    ),
  ],
);

export const ingredients = pgTable(
  "ingredients",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    amount: numeric("amount"),
    unit: text("unit"),
    item: text("item").notNull(),
  },
  (t) => [
    uniqueIndex("ingredients_recipe_position").on(t.recipeId, t.position),
    index("ingredients_item_trgm").using("gin", sql`${t.item} gin_trgm_ops`),
  ],
);

export const recipeInstances = pgTable(
  "recipe_instances",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    flatId: uuid("flat_id")
      .notNull()
      .references(() => flats.id, { onDelete: "cascade" }),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "restrict" }),
    targetQuantity: integer("target_quantity").notNull(),
    designatedCookId: uuid("designated_cook_id").references(() => users.id),
    position: integer("position").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finalisedAt: timestamp("finalised_at", { withTimezone: true }),
    cookedAt: timestamp("cooked_at", { withTimezone: true }),
    cookedBy: uuid("cooked_by").references(() => users.id),
    note: text("note"),
    /**
     * Ingredient UUIDs (from {@link ingredients}) omitted from this
     * instance: struck through on the drafted recipe page and dropped
     * from the Bring! export. Set on the draft; kept through finalise.
     */
    omittedIngredientIds: jsonb("omitted_ingredient_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (t) => [
    check(
      "recipe_instances_cooked_requires_finalised",
      sql`${t.cookedAt} is null or ${t.finalisedAt} is not null`,
    ),
    // NOTE: no `position >= 0` check — the move/reorder logic uses
    // a transient negative sentinel inside its swap transaction.
    check(
      "recipe_instances_target_quantity_range",
      sql`${t.targetQuantity} >= 1 and ${t.targetQuantity} <= 1000`,
    ),
    uniqueIndex("recipe_instances_draft_position")
      .on(t.flatId, t.position)
      .where(sql`finalised_at is null`),
    uniqueIndex("recipe_instances_in_stock_position")
      .on(t.flatId, t.position)
      .where(sql`finalised_at is not null and cooked_at is null`),
    index("recipe_instances_draft_idx")
      .on(t.flatId)
      .where(sql`finalised_at is null`),
    index("recipe_instances_in_stock_idx")
      .on(t.flatId)
      .where(sql`finalised_at is not null and cooked_at is null`),
    index("recipe_instances_cooked_idx")
      .on(t.flatId, sql`cooked_at desc`)
      .where(sql`cooked_at is not null`),
  ],
);

export type User = typeof users.$inferSelect;
export type Flat = typeof flats.$inferSelect;
export type Recipe = typeof recipes.$inferSelect;
export type Ingredient = typeof ingredients.$inferSelect;
export type RecipeInstance = typeof recipeInstances.$inferSelect;

export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: text("client_id").notNull().unique(),
  clientName: text("client_name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    scope: text("scope").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("oauth_authorization_codes_expires_idx").on(t.expiresAt),
    check(
      "oauth_authorization_codes_method_s256",
      sql`${t.codeChallengeMethod} = 'S256'`,
    ),
  ],
);

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    type: text("type").notNull(),
    clientId: text("client_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    parentHash: text("parent_hash"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("oauth_tokens_user_id_idx").on(t.userId),
    check("oauth_tokens_type", sql`${t.type} in ('access','refresh')`),
  ],
);

export type OauthClient = typeof oauthClients.$inferSelect;
export type OauthToken = typeof oauthTokens.$inferSelect;

/**
 * Cache of ingredient-text embeddings, keyed by (model, exact text).
 * Populated during shopping-list dedup so we don't re-pay/re-wait on
 * embeddings across recipes and flats. See app/lib/embeddings.ts.
 *
 * `text` stores the exact item string (no normalization) so the cached
 * vector is always faithful to what the model saw. `embedding` is a
 * dimensionless pgvector column (see the `vector` customType above).
 */
export const ingredientEmbeddings = pgTable(
  "ingredient_embeddings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    model: text("model").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("ingredient_embeddings_model_text").on(t.model, t.text)],
);

export type IngredientEmbedding = typeof ingredientEmbeddings.$inferSelect;

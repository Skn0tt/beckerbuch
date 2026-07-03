/**
 * Seed training set for the ingredient embedding adapter.
 *
 * Each example is a pair of ingredient *item* texts (the same string the
 * dedup pipeline embeds) with a label:
 *   - "positive": the same ingredient written differently — MUST cluster.
 *   - "negative": genuinely different ingredients — MUST stay apart.
 *
 * The adapter is a single linear map W (cosine on W·x). That makes one
 * rule matter above all others when curating pairs:
 *
 *   DO NOT teach "base == qualifier+base" as a positive when you also
 *   teach "base != other-qualifier+base" as a negative.
 *
 * e.g. "Vollmilch == Milch" (positive) and "Kokosmilch != Milch"
 * (negative) are the *same surface shape* with opposite labels. Vollmilch
 * and Kokosmilch sit in near-identical geometry relative to Milch, so no
 * linear W can pull one in and push the other out — it just picks the
 * majority and both suffer. We hit exactly this in early training.
 *
 * So the positives here are restricted to transformations a linear map
 * *can* learn without contradicting the negatives:
 *   - word-order / reordering (same tokens, shuffled)
 *   - inflection (singular/plural, adjective endings)
 *   - true synonyms (different tokens, same referent: Möhren/Karotten)
 * The negatives are the discriminations we care about: base-vs-processed,
 * "X+base is a different product", and near-synonyms.
 *
 * This is still a *seed*. Grow it from real prod ingredient texts — the
 * more real word-order/compound variants and near-miss negatives you add,
 * the better the adapter generalizes. Keep it roughly balanced.
 */
export type PairLabel = "positive" | "negative";

export type PairExample = {
  a: string;
  b: string;
  label: PairLabel;
  /** Optional note on why — documentation only, ignored by the trainer. */
  note?: string;
};

export const PAIRS: PairExample[] = [
  // === POSITIVES ======================================================

  // --- word order: adjective <-> postfixed adjective (same tokens) ----
  { a: "gehackte Tomaten", b: "Tomaten, gehackt", label: "positive" },
  { a: "glatte Petersilie", b: "Petersilie, glatt", label: "positive" },
  { a: "rote Zwiebel", b: "Zwiebel, rot", label: "positive" },
  { a: "rote Paprika", b: "Paprika, rot", label: "positive" },
  { a: "grüne Paprika", b: "Paprika, grün", label: "positive" },
  { a: "natives Olivenöl", b: "Olivenöl, nativ", label: "positive" },
  { a: "frische Petersilie", b: "Petersilie, frisch", label: "positive" },
  { a: "getrockneter Oregano", b: "Oregano, getrocknet", label: "positive" },
  { a: "getrocknete Tomaten", b: "Tomaten, getrocknet", label: "positive" },
  { a: "geriebener Parmesan", b: "Parmesan, gerieben", label: "positive" },
  { a: "gemahlener Zimt", b: "Zimt, gemahlen", label: "positive" },
  { a: "gemahlener Kreuzkümmel", b: "Kreuzkümmel, gemahlen", label: "positive" },
  { a: "gewürfelte Zwiebel", b: "Zwiebel, gewürfelt", label: "positive" },
  { a: "gehackter Knoblauch", b: "Knoblauch, gehackt", label: "positive" },
  { a: "passierte Tomaten", b: "Tomaten, passiert", label: "positive" },
  { a: "geschälte Mandeln", b: "Mandeln, geschält", label: "positive" },
  { a: "frischer Ingwer", b: "Ingwer, frisch", label: "positive" },
  { a: "geräucherter Speck", b: "Speck, geräuchert", label: "positive" },
  { a: "brauner Zucker", b: "Zucker, braun", label: "positive" },
  { a: "gehackte Walnüsse", b: "Walnüsse, gehackt", label: "positive" },
  {
    a: "frisch gemahlener Pfeffer",
    b: "Pfeffer, frisch gemahlen",
    label: "positive",
  },
  {
    a: "klein gewürfelte Zwiebel",
    b: "Zwiebel, klein gewürfelt",
    label: "positive",
  },
  {
    a: "abgeriebene Zitronenschale",
    b: "Zitronenschale, abgerieben",
    label: "positive",
  },

  // --- compound <-> phrasing (reordered, tokens preserved) ------------
  { a: "Knoblauchzehen", b: "Zehen Knoblauch", label: "positive" },
  { a: "Knoblauchzehe", b: "Zehe Knoblauch", label: "positive" },
  { a: "Zitronensaft", b: "Saft einer Zitrone", label: "positive" },
  { a: "Limettensaft", b: "Saft einer Limette", label: "positive" },
  { a: "Orangensaft", b: "Saft einer Orange", label: "positive" },
  { a: "Olivenöl", b: "Öl, Oliven-", label: "positive" },
  { a: "Hähnchenbrustfilet", b: "Hähnchenbrust, Filet", label: "positive" },
  { a: "Vanilleschote", b: "Schote Vanille", label: "positive" },
  { a: "Tomatensauce", b: "Sauce aus Tomaten", label: "positive" },

  // --- singular / plural / inflection ---------------------------------
  { a: "Zwiebeln", b: "Zwiebel", label: "positive" },
  { a: "Tomaten", b: "Tomate", label: "positive" },
  { a: "Karotten", b: "Karotte", label: "positive" },
  { a: "Eier", b: "Ei", label: "positive" },
  { a: "Kartoffeln", b: "Kartoffel", label: "positive" },
  { a: "Zitronen", b: "Zitrone", label: "positive" },
  { a: "Äpfel", b: "Apfel", label: "positive" },
  { a: "Champignons", b: "Champignon", label: "positive" },
  { a: "Möhren", b: "Möhre", label: "positive" },
  { a: "Paprikaschoten", b: "Paprikaschote", label: "positive" },

  // --- true synonyms (different tokens, same referent) ----------------
  { a: "Möhren", b: "Karotten", label: "positive", note: "synonym" },
  {
    a: "Frühlingszwiebeln",
    b: "Lauchzwiebeln",
    label: "positive",
    note: "synonym",
  },
  { a: "Aubergine", b: "Melanzani", label: "positive", note: "AT synonym" },
  { a: "Blumenkohl", b: "Karfiol", label: "positive", note: "AT synonym" },
  { a: "Quark", b: "Topfen", label: "positive", note: "AT synonym" },
  { a: "Kartoffeln", b: "Erdäpfel", label: "positive", note: "AT synonym" },
  { a: "Hackfleisch", b: "Faschiertes", label: "positive", note: "AT synonym" },
  { a: "Tomaten", b: "Paradeiser", label: "positive", note: "AT synonym" },
  { a: "Sahne", b: "Rahm", label: "positive", note: "synonym" },
  { a: "Rosinen", b: "Sultaninen", label: "positive", note: "synonym" },
  { a: "Brötchen", b: "Semmel", label: "positive", note: "synonym" },
  { a: "Speisestärke", b: "Stärke", label: "positive", note: "synonym" },
  { a: "Natron", b: "Backsoda", label: "positive", note: "synonym" },
  { a: "Puderzucker", b: "Staubzucker", label: "positive", note: "AT synonym" },
  { a: "grüne Bohnen", b: "Fisolen", label: "positive", note: "AT synonym" },

  // --- spelling / notation variants -----------------------------------
  { a: "Joghurt", b: "Jogurt", label: "positive" },
  { a: "Spaghetti", b: "Spagetti", label: "positive" },
  { a: "Crème fraîche", b: "Creme fraiche", label: "positive" },
  { a: "Magerquark", b: "Quark, mager", label: "positive" },

  // === NEGATIVES ======================================================

  // --- base vs processed form -----------------------------------------
  { a: "Paprika", b: "Paprikapulver", label: "negative" },
  { a: "Knoblauch", b: "Knoblauchpulver", label: "negative" },
  { a: "Zwiebel", b: "Zwiebelpulver", label: "negative" },
  { a: "Tomate", b: "Tomatenmark", label: "negative" },
  { a: "Zitrone", b: "Zitronenschale", label: "negative" },
  { a: "Ingwer", b: "Ingwerpulver", label: "negative" },
  { a: "Zucker", b: "Puderzucker", label: "negative" },
  { a: "Mandeln", b: "Mandelmus", label: "negative" },
  { a: "Chili", b: "Chilipulver", label: "negative" },
  { a: "Curry", b: "Currypaste", label: "negative" },
  { a: "Oliven", b: "Olivenöl", label: "negative" },
  { a: "Sesam", b: "Sesamöl", label: "negative" },
  { a: "Hafer", b: "Haferflocken", label: "negative" },
  { a: "Apfel", b: "Apfelmus", label: "negative" },
  { a: "Vanille", b: "Vanillezucker", label: "negative" },
  { a: "Kartoffel", b: "Kartoffelstärke", label: "negative" },
  { a: "Senf", b: "Senfkörner", label: "negative" },
  { a: "Kokos", b: "Kokosöl", label: "negative" },
  { a: "Erdnüsse", b: "Erdnussbutter", label: "negative" },
  { a: "Milch", b: "Milchpulver", label: "negative" },

  // --- "X + base" is a different product (the milk-family boundary) ----
  { a: "Milch", b: "Kokosmilch", label: "negative" },
  { a: "Milch", b: "Mandelmilch", label: "negative" },
  { a: "Milch", b: "Hafermilch", label: "negative" },
  { a: "Butter", b: "Buttermilch", label: "negative" },
  { a: "Reis", b: "Reismilch", label: "negative" },
  { a: "Kokosmilch", b: "Kokoswasser", label: "negative" },
  { a: "Soja", b: "Sojasauce", label: "negative" },
  { a: "Wein", b: "Weinessig", label: "negative" },
  { a: "Apfel", b: "Apfelessig", label: "negative" },
  { a: "Zucker", b: "Zuckerrübensirup", label: "negative" },

  // --- near-synonyms: similar but distinct ----------------------------
  { a: "Zitrone", b: "Limette", label: "negative" },
  { a: "Petersilie", b: "Koriander", label: "negative" },
  { a: "Sellerie", b: "Staudensellerie", label: "negative" },
  { a: "Basilikum", b: "Oregano", label: "negative" },
  { a: "Majoran", b: "Oregano", label: "negative" },
  { a: "Dill", b: "Fenchel", label: "negative" },
  { a: "Rosmarin", b: "Thymian", label: "negative" },
  { a: "Kreuzkümmel", b: "Kümmel", label: "negative" },
  { a: "Süßkartoffel", b: "Kartoffel", label: "negative" },
  { a: "Zwiebel", b: "Schalotte", label: "negative" },
  { a: "Frühlingszwiebel", b: "Lauch", label: "negative" },
  { a: "Schnittlauch", b: "Frühlingszwiebel", label: "negative" },
  {
    a: "Schmand",
    b: "Saure Sahne",
    label: "negative",
    note: "close but graded apart",
  },
  { a: "Crème fraîche", b: "Schmand", label: "negative" },
  { a: "Quark", b: "Skyr", label: "negative" },
  { a: "Joghurt", b: "Quark", label: "negative" },
  { a: "Mozzarella", b: "Burrata", label: "negative" },
  { a: "Parmesan", b: "Pecorino", label: "negative" },
  { a: "Rapsöl", b: "Olivenöl", label: "negative" },
  { a: "Sonnenblumenöl", b: "Olivenöl", label: "negative" },
  { a: "Weizenmehl", b: "Dinkelmehl", label: "negative" },
  { a: "Honig", b: "Ahornsirup", label: "negative" },
  { a: "Cashewkerne", b: "Erdnüsse", label: "negative" },
  { a: "Walnüsse", b: "Haselnüsse", label: "negative" },
  { a: "Rucola", b: "Feldsalat", label: "negative" },
  { a: "Kidneybohnen", b: "Kichererbsen", label: "negative" },
  { a: "Basmatireis", b: "Risottoreis", label: "negative" },
  { a: "Rotwein", b: "Weißwein", label: "negative" },

  // --- obvious negatives (anchor the space) ---------------------------
  { a: "Mehl", b: "Zucker", label: "negative" },
  { a: "Knoblauch", b: "Basmatireis", label: "negative" },
  { a: "Olivenöl", b: "Backpulver", label: "negative" },
  { a: "Salz", b: "Zimt", label: "negative" },
  { a: "Ei", b: "Mehl", label: "negative" },
  { a: "Wasser", b: "Essig", label: "negative" },
];

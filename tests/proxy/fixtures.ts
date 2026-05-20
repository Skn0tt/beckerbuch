// Test fixtures for the mockttp proxy mocks. Imported both by the
// mock helpers (which serve these payloads) and by the specs (which
// assert against them), so they stay the single source of truth.

// Smallest possible valid JPEG: 1×1 white pixel. The kptncook photo
// fetcher validates the response is a real image, so a bare 200 with
// arbitrary bytes wouldn't do.
export const TINY_JPEG = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb0043000806060706050806070707090908" +
    "0a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434" +
    "341f27393d38323c2e333432ffdb0043010909090c0b0c180d0d1832211c213232323232323232" +
    "32323232323232323232323232323232323232323232323232323232323232323232323232ffc0" +
    "00110800010001030122000211010311010011010000ffc4001f0000010501010101010100000000" +
    "000000000102030405060708090a0bffc4002fb50001020403020401030604030500000000000001" +
    "020003040511122131410651076171132281321442a116152332ffc400b50100020103030204030505" +
    "0405040000010277000102031104052131061241075161711322328108144291a1b1c109233352f015627" +
    "2d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465" +
    "66676869736374757677787985868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b" +
    "8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda" +
    "000c03010002110311003f00fbfb0a28a2803fffd9",
  "hex",
);

// Test API key the kptncook helper accepts. Worker fixtures set this
// as KPTNCOOK_API_KEY on the netlify-dev child env.
export const KPTNCOOK_TEST_API_KEY = "test-kptn-api-key";

export interface MockKptncookRecipe {
  oid: string;
  uid: string;
  shareToken: string;
  payload: Record<string, unknown>;
}

const cinnamonBuns: MockKptncookRecipe = {
  oid: "0123456789abcdef01234567",
  uid: "BUN12345",
  shareToken: "BUN12345",
  payload: {
    _id: { $oid: "0123456789abcdef01234567" },
    uid: "BUN12345",
    localizedTitle: { de: "Zimtschnecken", en: "Cinnamon buns" },
    preparationTime: 30,
    cookingTime: 25,
    recipeNutrition: { calories: 320, protein: 6, fat: 12, carbohydrate: 48 },
    imageList: [
      {
        name: "cover",
        type: "cover",
        // Real kptncook image host — the proxy intercepts both this
        // and mobile.kptncook.com/share.kptncook.com.
        url: "https://mobile.kptncook.com/images/buns-cover.jpg",
      },
    ],
    ingredients: [
      {
        quantity: 250,
        measure: "g",
        ingredient: {
          _id: { $oid: "aaaaaaaaaaaaaaaaaaaaaaaa" },
          typ: "ingredient",
          localizedTitle: { de: "Mehl", en: "flour" },
          numberTitle: { de: "Mehl", en: "flour" },
          uncountableTitle: { de: "Mehl", en: "flour" },
          category: "baking",
        },
      },
      {
        quantity: 150,
        measure: "ml",
        ingredient: {
          _id: { $oid: "bbbbbbbbbbbbbbbbbbbbbbbb" },
          typ: "ingredient",
          localizedTitle: { de: "Milch", en: "milk" },
          numberTitle: { de: "Milch", en: "milk" },
          uncountableTitle: { de: "Milch", en: "milk" },
          category: "dairy",
        },
      },
      {
        quantity: 2,
        measure: null,
        ingredient: {
          _id: { $oid: "cccccccccccccccccccccccc" },
          typ: "ingredient",
          localizedTitle: { de: "Eier", en: "eggs" },
          numberTitle: { de: "Eier", en: "eggs" },
          uncountableTitle: { de: "Eier", en: "eggs" },
          category: "dairy",
        },
      },
    ],
    steps: [
      {
        title: { de: "Teig anrühren und ruhen lassen.", en: "Mix the dough and let it rest." },
        image: { name: "step1", url: "https://mobile.kptncook.com/images/step1.jpg" },
      },
      {
        title: { de: "Zimt-Zucker-Füllung verteilen, rollen und schneiden.", en: "Spread the filling, roll and slice." },
        image: { name: "step2", url: "https://mobile.kptncook.com/images/step2.jpg" },
      },
      {
        title: { de: "Bei 180 °C 25 Minuten backen.", en: "Bake at 180 °C for 25 minutes." },
        image: { name: "step3", url: "https://mobile.kptncook.com/images/step3.jpg" },
      },
    ],
  },
};

export const MOCK_RECIPES = { cinnamonBuns };

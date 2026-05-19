export const TINY_JPEG: Buffer;
export const KPTNCOOK_TEST_API_KEY: string;

export interface MockKptncookRecipe {
  oid: string;
  uid: string;
  shareToken: string;
  payload: Record<string, unknown>;
}

export const MOCK_RECIPES: {
  cinnamonBuns: MockKptncookRecipe;
};

export const ALL_KPTNCOOK_RECIPES: MockKptncookRecipe[];

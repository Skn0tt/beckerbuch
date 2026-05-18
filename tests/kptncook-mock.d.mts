import type { Server } from "node:http";

export const KPTNCOOK_MOCK_PORT: number;
export const KPTNCOOK_MOCK_API_KEY: string;
export const TINY_JPEG: Buffer;

export interface MockRecipe {
  oid: string;
  uid: string;
  shareToken: string;
  payload: Record<string, unknown>;
}

export const MOCK_RECIPES: {
  cinnamonBuns: MockRecipe;
};

export function startKptncookMock(): Promise<Server>;

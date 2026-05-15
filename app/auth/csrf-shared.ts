// Constants safe to import in both server and client modules.
// Keep this file free of node:* imports.
export const CSRF_FIELD_NAME = "_csrf";

export function csrfFieldName(): string {
  return CSRF_FIELD_NAME;
}

import { CSRF_FIELD_NAME } from "./csrf-shared";

export function CsrfField({ token }: { token: string }) {
  return <input type="hidden" name={CSRF_FIELD_NAME} value={token} />;
}

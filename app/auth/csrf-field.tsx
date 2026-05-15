import { csrfFieldName, csrfTokenForSession } from "./csrf";

export function CsrfField({ sessionId }: { sessionId: string }) {
  return (
    <input
      type="hidden"
      name={csrfFieldName()}
      value={csrfTokenForSession(sessionId)}
    />
  );
}

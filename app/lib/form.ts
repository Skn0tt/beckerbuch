import { data } from "react-router";
import type { z } from "zod";

export function firstMessage(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Bad request.";
}

/**
 * Convert FormData to a plain object. Repeated keys collapse into an array
 * so Zod schemas can validate them via `z.array(...)`.
 */
export function formDataToObject(
  form: FormData,
): Record<string, FormDataEntryValue | FormDataEntryValue[]> {
  const out: Record<string, FormDataEntryValue | FormDataEntryValue[]> = {};
  for (const key of new Set(form.keys())) {
    const values = form.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

/**
 * Parse route params through a Zod schema. Throws a 404 Response on
 * mismatch — typical for malformed UUIDs in the URL, which would
 * otherwise blow up at the Postgres layer with `22P02 invalid uuid`.
 */
export function parseParams<T extends z.ZodType>(
  schema: T,
  params: unknown,
  notFoundMessage = "Not found.",
): z.infer<T> {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw data(notFoundMessage, { status: 404 });
  }
  return result.data;
}


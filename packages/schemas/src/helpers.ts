// SPDX-FileCopyrightText: 2026 British Club Challenge authors
// SPDX-License-Identifier: MPL-2.0
import * as z from "zod/v4";

type AnySchema = z.ZodType<unknown>;

export const UuidIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "must be a UUID",
);

export function healed<T>(schema: z.ZodType<T>, fallback: T): z.ZodType<T> {
  return schema.catch(fallback);
}

export function lenientOptional<T extends AnySchema>(
  schema: T,
): z.ZodType<z.output<T> | undefined> {
  return schema.optional().catch(undefined);
}

export function healingArray<T extends AnySchema>(
  elem: T,
): z.ZodType<Array<z.output<T>>> {
  return z
    .array(z.unknown())
    .catch([])
    .transform((items) => {
      const healedItems: Array<z.output<T>> = [];

      for (const item of items) {
        try {
          const parsed = elem.safeParse(item);
          if (parsed.success) {
            healedItems.push(parsed.data as z.output<T>);
          }
        } catch {
          continue;
        }
      }

      return healedItems;
    });
}

export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }

  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }

    return a.every((value, index) => jsonDeepEqual(value, b[index]));
  }

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);

  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRecord, key)) {
      return false;
    }

    if (!jsonDeepEqual(aRecord[key], bRecord[key])) {
      return false;
    }
  }

  return true;
}

export function normalizeEnum<T>(
  values: readonly T[],
  aliases: Record<string, T> = {},
): (raw: unknown) => T | undefined {
  const validValues = new Set<T>(values);

  return (raw: unknown) => {
    if (typeof raw !== "string") {
      return undefined;
    }

    if (validValues.has(raw as T)) {
      return raw as T;
    }

    return aliases[raw];
  };
}

import { z } from 'zod';

/** Validate values as tuples so Zod's record output cannot discard own __proto__ keys. */
export function ownEntriesSchema<T extends z.ZodType>(valueSchema: T) {
  return z.preprocess(
    value => value != null && Object.prototype.toString.call(value) === '[object Object]'
      ? Object.entries(value)
      : null,
    z.array(z.tuple([z.string(), valueSchema])),
  );
}

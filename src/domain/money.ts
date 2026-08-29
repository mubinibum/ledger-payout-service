/**
 * Money representation.
 *
 * Money is an integer number of **minor units** (cents, sen, …) held as a JS `bigint`
 * end to end and stored in PostgreSQL `BIGINT`. There is no floating point anywhere in
 * the value path. Over the wire, amounts are JSON strings of digits ("1500" = 15.00 of a
 * 2-decimal currency) so a JSON parser can never round them.
 *
 * This service does not know currency exponents (no minor-unit-per-currency table) — it
 * only moves and compares integer amounts within a single currency, which is all M2 needs.
 */

/** Largest amount we accept in one request: 1e15 minor units. Well inside BIGINT range. */
const MAX_MINOR = 1_000_000_000_000_000n;

export function parseMinorUnits(input: string | number): bigint {
  let value: bigint;
  if (typeof input === 'number') {
    if (!Number.isInteger(input)) {
      throw new RangeError('amount must be an integer number of minor units');
    }
    value = BigInt(input);
  } else if (/^\d+$/.test(input)) {
    value = BigInt(input);
  } else {
    throw new RangeError('amount must be a string of digits (minor units)');
  }
  if (value <= 0n) throw new RangeError('amount must be greater than zero');
  if (value > MAX_MINOR) throw new RangeError('amount exceeds the maximum supported value');
  return value;
}

/** Canonical string form for API responses and fingerprints. */
export function formatMinorUnits(value: bigint): string {
  return value.toString(10);
}

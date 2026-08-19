/**
 * LangGraph `SearchOperation.filter` matching, applied IN-PROCESS.
 *
 * Mnemo's `/v1/search` has no documented contract for filtering on arbitrary
 * item fields, so the filter is evaluated here against the values we already
 * fetched. That is exact but NOT pushed down: a filter never widens the
 * candidate set the API returned, so a highly selective filter over a large
 * container can come back short. See the README's "Exact vs approximated"
 * table.
 */

const OPERATORS = ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"] as const;
type Operator = (typeof OPERATORS)[number];

function isOperatorRecord(
  condition: unknown,
): condition is Partial<Record<Operator, unknown>> {
  if (typeof condition !== "object" || condition === null) return false;
  if (Array.isArray(condition)) return false;
  const keys = Object.keys(condition);
  return (
    keys.length > 0 &&
    keys.every((key) => (OPERATORS as readonly string[]).includes(key))
  );
}

function compare(actual: unknown, operator: Operator, expected: unknown): boolean {
  switch (operator) {
    case "$eq":
      return deepEqual(actual, expected);
    case "$ne":
      return !deepEqual(actual, expected);
    case "$gt":
    case "$gte":
    case "$lt":
    case "$lte": {
      // Relational operators are meaningless across mixed types — treat a
      // type mismatch as "does not match" rather than coercing.
      if (typeof actual !== typeof expected) return false;
      if (typeof actual !== "number" && typeof actual !== "string") return false;
      const left = actual as number | string;
      const right = expected as number | string;
      if (operator === "$gt") return left > right;
      if (operator === "$gte") return left >= right;
      if (operator === "$lt") return left < right;
      return left <= right;
    }
    default:
      return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** True when `value` satisfies every condition in `filter`. */
export function matchesFilter(
  value: Record<string, unknown>,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (!filter) return true;
  for (const [field, condition] of Object.entries(filter)) {
    const actual = value[field];
    if (isOperatorRecord(condition)) {
      for (const [operator, expected] of Object.entries(condition)) {
        if (!compare(actual, operator as Operator, expected)) return false;
      }
      continue;
    }
    if (!deepEqual(actual, condition)) return false;
  }
  return true;
}

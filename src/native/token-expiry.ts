// Only the exact integer 0 means no expiry in the existing NOT NULL SQLite column.
// Public/admin metadata uses null; missing or damaged stored values must fail closed.
export function tokenExpiryActive(expiresAt: unknown, now: number): boolean {
  return (
    expiresAt === 0 ||
    (typeof expiresAt === "number" &&
      Number.isSafeInteger(expiresAt) &&
      expiresAt > 0 &&
      expiresAt > now)
  );
}

export function capSessionExpiry(sessionExpiresAt: number, tokenExpiresAt: number): number {
  return tokenExpiresAt === 0 ? sessionExpiresAt : Math.min(sessionExpiresAt, tokenExpiresAt);
}

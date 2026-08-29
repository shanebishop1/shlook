import { describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret } from "./secret-crypto";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const assetId = "11111111-1111-4111-8111-111111111111";

describe("secret capability encryption", () => {
  it("round-trips with unique authenticated ciphertext", async () => {
    const secret = "a".repeat(43);
    const first = await encryptSecret(secret, assetId, key);
    const second = await encryptSecret(secret, assetId, key);

    expect(first.ciphertext).not.toContain(secret);
    expect(first).not.toEqual(second);
    await expect(decryptSecret(first.ciphertext, first.iv, assetId, key)).resolves.toBe(secret);
    await expect(
      decryptSecret(first.ciphertext, first.iv, `${assetId}-other`, key),
    ).rejects.toThrow();
  });

  it("rejects invalid encryption keys", async () => {
    await expect(encryptSecret("a".repeat(43), assetId, "not-a-key")).rejects.toThrow(
      "32-byte base64 key",
    );
  });
});

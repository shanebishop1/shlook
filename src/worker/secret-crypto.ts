const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function decodeBase64(value: string, label: string): Uint8Array {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new Error(`invalid ${label}`);
  }
}

function encodeBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function encryptionKey(value: string): Promise<CryptoKey> {
  const bytes = decodeBase64(value, "32-byte base64 key");
  if (bytes.byteLength !== 32) throw new Error("invalid 32-byte base64 key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(
  secret: string,
  assetId: string,
  keyValue: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: textEncoder.encode(assetId), tagLength: 128 },
    await encryptionKey(keyValue),
    textEncoder.encode(secret),
  );
  return { ciphertext: encodeBase64Url(ciphertext), iv: encodeBase64Url(iv) };
}

export async function decryptSecret(
  ciphertext: string,
  iv: string,
  assetId: string,
  keyValue: string,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decodeBase64(iv, "secret IV"),
      additionalData: textEncoder.encode(assetId),
      tagLength: 128,
    },
    await encryptionKey(keyValue),
    decodeBase64(ciphertext, "secret ciphertext"),
  );
  return textDecoder.decode(plaintext);
}

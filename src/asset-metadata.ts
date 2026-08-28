export const assetNameMaxLength = 80;
export const assetDescriptionMaxLength = 500;

export interface AssetMetadata {
  name: string;
  description: string | null;
}

export function normalizeAssetMetadata(
  nameValue: unknown,
  descriptionValue: unknown,
): AssetMetadata | null {
  if (typeof nameValue !== "string") return null;
  const name = nameValue.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > assetNameMaxLength) return null;
  if (
    descriptionValue !== undefined &&
    descriptionValue !== null &&
    typeof descriptionValue !== "string"
  ) {
    return null;
  }
  const description = typeof descriptionValue === "string" ? descriptionValue.trim() || null : null;
  if (description !== null && description.length > assetDescriptionMaxLength) return null;
  return { name, description };
}

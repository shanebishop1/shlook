export interface OwnerAsset {
  id: string;
  name: string;
  description: string | null;
  visibility: "private" | "secret_link" | "public";
  has_secret: number;
  secret_url: string | null;
  share_expires_at: string | null;
  hard_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OwnerAssetRow extends Omit<OwnerAsset, "has_secret" | "secret_url"> {
  secret_hash: string | null;
  secret_ciphertext: string | null;
  secret_iv: string | null;
}

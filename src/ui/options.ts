/** Portable archive defaults; no storage/runtime dependencies. */
export const pageSize = 24;

export interface OwnerCapabilities {
  publish: boolean;
  delete: boolean;
  hardExpiry: boolean;
  sharing: boolean;
  directories: boolean;
  resolvePreviewEntrypoint?: boolean;
}

export const ownerCapabilities: OwnerCapabilities = {
  publish: true,
  delete: true,
  hardExpiry: true,
  sharing: true,
  directories: false,
};

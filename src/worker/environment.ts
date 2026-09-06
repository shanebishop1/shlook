export interface DeploymentEnv {
  SHLOOK_OWNER_ORIGIN: string;
  SHLOOK_PRIVATE_ORIGIN: string;
  SHLOOK_PUBLIC_ORIGIN: string;
  SHLOOK_SHARE_ORIGIN: string;
  SHLOOK_OWNER_EMAIL: string;
  SHLOOK_SECRET_ENCRYPTION_KEY?: string;
}

export interface Env extends DeploymentEnv {
  ASSETS: R2Bucket;
  DB: D1Database;
}

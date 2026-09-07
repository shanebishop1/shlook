import { Buffer } from "node:buffer";

import type { ApplySetupResult, SetupDeploymentManifest } from "../../cli-setup.ts";

export const ACCOUNT_ID = "a".repeat(32);
export const OTHER_ACCOUNT_ID = "c".repeat(32);
export const ZONE_ID = "b".repeat(32);
export const BOOTSTRAP_TOKEN = "bootstrap-token";
export const ACCESS_SECRET = "access-secret";
export const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

export const applied: ApplySetupResult = {
  mode: "apply",
  account: { id: ACCOUNT_ID, name: "Primary account" },
  zone: { id: ZONE_ID, name: "example.com" },
  origins: {
    owner: "https://shlook.example.com",
    private: "https://private.example.com",
    public: "https://public.example.com",
    share: "https://share.example.com",
  },
  resources: {
    d1: { id: "database-id", name: "shlook", created: true },
    r2: { id: "shlook-assets", name: "shlook-assets", created: true },
    accessApplications: {
      owner: {
        id: "owner-app-id",
        name: "shlook-owner",
        domain: "shlook.example.com",
        created: true,
      },
      private: {
        id: "private-app-id",
        name: "shlook-private",
        domain: "private.example.com",
        created: true,
      },
    },
    accessPolicies: {
      owner: {
        email: { id: "owner-email-policy", name: "shlook-owner-email", created: true },
        serviceToken: {
          id: "owner-token-policy",
          name: "shlook-service-token",
          created: true,
        },
      },
      private: {
        email: { id: "private-email-policy", name: "shlook-owner-email", created: true },
        serviceToken: {
          id: "private-token-policy",
          name: "shlook-service-token",
          created: true,
        },
      },
    },
    accessServiceToken: {
      id: "service-token-id",
      name: "shlook",
      clientId: "access-client-id",
      created: true,
    },
  },
  createdServiceTokenCredentials: {
    clientId: "access-client-id",
    clientSecret: ACCESS_SECRET,
  },
};

export const deploymentManifest: SetupDeploymentManifest = {
  version: 1,
  domain: "example.com",
  ownerEmail: "owner@example.com",
  accountId: ACCOUNT_ID,
  zoneId: ZONE_ID,
  resources: {
    d1: { action: "create", name: "shlook", id: "database-id" },
    r2: { action: "create", name: "shlook-assets", id: "shlook-assets" },
    access_application_owner: { action: "create", name: "shlook-owner", id: "owner-app-id" },
    access_application_private: {
      action: "create",
      name: "shlook-private",
      id: "private-app-id",
    },
    access_service_token: { action: "create", name: "shlook", id: "service-token-id" },
    access_email_policy_owner: {
      action: "create",
      name: "shlook-owner-email",
      id: "owner-email-policy",
    },
    access_email_policy_private: {
      action: "create",
      name: "shlook-owner-email",
      id: "private-email-policy",
    },
    access_service_token_policy_owner: {
      action: "create",
      name: "shlook-service-token",
      id: "owner-token-policy",
    },
    access_service_token_policy_private: {
      action: "create",
      name: "shlook-service-token",
      id: "private-token-policy",
    },
    worker_service: { action: "create", name: "shlook", id: "shlook" },
    workers_domain_owner: {
      action: "create",
      name: "shlook.example.com",
      id: "owner-domain-id",
    },
    workers_domain_private: {
      action: "create",
      name: "private.example.com",
      id: "private-domain-id",
    },
    workers_domain_public: {
      action: "create",
      name: "public.example.com",
      id: "public-domain-id",
    },
    workers_domain_share: {
      action: "create",
      name: "share.example.com",
      id: "share-domain-id",
    },
  },
};

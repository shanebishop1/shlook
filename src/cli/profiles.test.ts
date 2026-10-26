import { describe, expect, it } from "vitest";
import { normalizedTokenEnv, profileNameValid, validateProfileConfig } from "./profiles.ts";

describe("named instance profiles", () => {
  it("normalizes names without accepting lossy name forms", () => {
    expect(profileNameValid("home-lab")).toBe(true);
    expect(profileNameValid("Home-Lab")).toBe(false);
    expect(profileNameValid("home_lab")).toBe(false);
    expect(normalizedTokenEnv("home-lab")).toBe("SHLOOK_API_TOKEN_HOME_LAB");
  });

  it("validates strict native profile schemas and loopback HTTP exception", () => {
    expect(
      validateProfileConfig({
        version: 1,
        default: "home",
        instances: { home: { type: "native", url: "https://home.example" } },
      }).default,
    ).toBe("home");
    expect(() =>
      validateProfileConfig({
        version: 1,
        instances: { home: { type: "native", url: "https://home.example", secret: "bad" } },
      }),
    ).toThrow();
    expect(() =>
      validateProfileConfig({
        version: 1,
        instances: { home: { type: "native", url: "http://home.example" } },
      }),
    ).toThrow();
    expect(
      validateProfileConfig({
        version: 1,
        instances: {
          local: { type: "native", url: "http://localhost:8789", allow_loopback_http: true },
        },
      }).instances.local?.type,
    ).toBe("native");
    expect(() =>
      validateProfileConfig({
        version: 1,
        instances: {
          local: { type: "native", url: "http://example.com", allow_loopback_http: true },
        },
      }),
    ).toThrow();
  });

  it("rejects ambiguous environment variable bindings and duplicate origins", () => {
    expect(() =>
      validateProfileConfig({
        version: 1,
        instances: {
          "home-lab": { type: "native", url: "https://a.example" },
          home_lab: { type: "native", url: "https://b.example" },
        },
      }),
    ).toThrow();
    expect(() =>
      validateProfileConfig({
        version: 1,
        instances: {
          home: { type: "native", url: "https://a.example" },
          office: { type: "native", url: "https://b.example", token_env: "SHLOOK_API_TOKEN_HOME" },
        },
      }),
    ).toThrow();
  });
});

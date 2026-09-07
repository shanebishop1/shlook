import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { hashSecret } from "../privacy";
import { decryptSecret } from "../secret-crypto";
import {
  createAsset,
  createLiveAsset,
  finalizeAsset,
  privateHost,
  publicHost,
  request,
  shareHost,
  uploadFile,
  uploadedFile,
} from "../test-harness";
import { setupWorkerTestDatabase } from "./test-setup";

setupWorkerTestDatabase();

describe("privacy and lifecycle", () => {
  it("stores a hash plus encrypted recovery data and serves a newly issued secret capability", async () => {
    const asset = await createLiveAsset("secret");
    const issued = await request(`/api/assets/${asset.id}/secret?mode=create`, { method: "POST" });
    const body = (await issued.json()) as { secret: string; url: string };
    const row = await env.DB.prepare(
      "SELECT secret_hash, secret_ciphertext, secret_iv FROM assets WHERE id = ?",
    )
      .bind(asset.id)
      .first<{ secret_hash: string; secret_ciphertext: string; secret_iv: string }>();

    expect(body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(body.url).origin).toBe(`https://${shareHost}`);
    expect(row?.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.secret_hash).not.toBe(body.secret);
    expect(row?.secret_ciphertext).not.toContain(body.secret);
    await expect(
      decryptSecret(
        row?.secret_ciphertext ?? "",
        row?.secret_iv ?? "",
        asset.id,
        env.SHLOOK_SECRET_ENCRYPTION_KEY,
      ),
    ).resolves.toBe(body.secret);
    expect((await request(`/assets/${asset.id}/`, undefined, shareHost, undefined)).status).toBe(
      404,
    );
    expect(
      await (await request(new URL(body.url).pathname, undefined, shareHost, undefined)).text(),
    ).toBe("secret");
    expect(
      (await request(new URL(body.url).pathname, undefined, publicHost, undefined)).status,
    ).toBe(404);
    expect(await (await request("/")).text()).toContain(body.url);
  });

  it("rotates and revokes secret capabilities", async () => {
    const asset = await createLiveAsset("secret");
    const first = (await (
      await request(`/api/assets/${asset.id}/secret?mode=create`, { method: "POST" })
    ).json()) as { url: string };
    expect(
      (await request(`/api/assets/${asset.id}/secret?mode=create`, { method: "POST" })).status,
    ).toBe(409);
    const second = (await (
      await request(`/api/assets/${asset.id}/secret?mode=rotate`, { method: "POST" })
    ).json()) as { url: string };
    const ownerArchive = await (await request("/")).text();

    expect(ownerArchive).toContain(second.url);
    expect(ownerArchive).not.toContain(first.url);
    expect(
      (await request(new URL(first.url).pathname, undefined, shareHost, undefined)).status,
    ).toBe(404);
    expect(
      (await request(new URL(second.url).pathname, undefined, shareHost, undefined)).status,
    ).toBe(200);
    expect((await request(`/api/assets/${asset.id}/secret`, { method: "DELETE" })).status).toBe(
      204,
    );
    await expect(
      env.DB.prepare("SELECT secret_hash, secret_ciphertext, secret_iv FROM assets WHERE id = ?")
        .bind(asset.id)
        .first(),
    ).resolves.toMatchObject({
      secret_hash: null,
      secret_ciphertext: null,
      secret_iv: null,
    });
    expect(
      (await request(new URL(second.url).pathname, undefined, shareHost, undefined)).status,
    ).toBe(404);
  });

  it("marks historical one-way secrets as requiring one final rotation", async () => {
    const asset = await createLiveAsset("historical secret");
    const historicalSecret = "h".repeat(43);
    await env.DB.prepare(
      "UPDATE assets SET secret_hash = ?, visibility = 'secret_link' WHERE id = ?",
    )
      .bind(await hashSecret(historicalSecret), asset.id)
      .run();

    const body = await (await request("/")).text();

    expect(body).toContain("Rotate once to recover this existing secret link");
    expect(body).not.toContain(historicalSecret);
  });

  it("expires sharing without removing private owner access", async () => {
    const asset = await createLiveAsset("expired share");
    await request(`/api/assets/${asset.id}/visibility`, {
      method: "PATCH",
      body: JSON.stringify({ visibility: "public" }),
    });
    await request(`/api/assets/${asset.id}/expiry`, {
      method: "PATCH",
      body: JSON.stringify({ hardExpiresAt: "2999-01-01T00:00:00.000Z" }),
    });
    await request(`/api/assets/${asset.id}/expiry`, {
      method: "PATCH",
      body: JSON.stringify({ shareExpiresAt: "2000-01-01T00:00:00.000Z" }),
    });

    expect((await request(`/assets/${asset.id}/`, undefined, publicHost, undefined)).status).toBe(
      404,
    );
    expect(await (await request(`/assets/${asset.id}/`, undefined, privateHost)).text()).toBe(
      "expired share",
    );
    const row = await env.DB.prepare("SELECT hard_expires_at FROM assets WHERE id = ?")
      .bind(asset.id)
      .first<{ hard_expires_at: string }>();
    expect(row?.hard_expires_at).toBe("2999-01-01T00:00:00.000Z");
  });

  it("serves explicitly public HTML only from the sandboxed public host", async () => {
    const asset = await createLiveAsset("<h1>public</h1>");
    expect((await request(`/assets/${asset.id}/`, undefined, publicHost, undefined)).status).toBe(
      404,
    );
    const visibility = await request(`/api/assets/${asset.id}/visibility`, {
      method: "PATCH",
      body: JSON.stringify({ visibility: "public" }),
    });

    expect(visibility.status).toBe(200);
    const shared = await request(`/assets/${asset.id}/`, undefined, publicHost, undefined);
    expect(await shared.text()).toBe("<h1>public</h1>");
    expect(shared.headers.get("content-security-policy")).toContain("sandbox");

    const svg = await createAsset();
    const svgUpload = await uploadFile(svg.id, "image.svg", "<svg/>", "Image/SVG+XML");
    await finalizeAsset(svg.id, [await uploadedFile(svgUpload)], "image.svg");
    await request(`/api/assets/${svg.id}/visibility`, {
      method: "PATCH",
      body: JSON.stringify({ visibility: "public" }),
    });
    const sharedSvg = await request(`/assets/${svg.id}/`, undefined, publicHost, undefined);
    expect(sharedSvg.headers.get("content-security-policy")).toContain("sandbox");
    expect((await request(`/assets/${asset.id}/`, undefined, shareHost, undefined)).status).toBe(
      404,
    );
  });
});

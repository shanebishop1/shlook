import assert from "node:assert/strict";
import test from "node:test";
import { nativeRequestScript, nativePreviewScript } from "../../src/native/ui/transport.ts";
import { nativeUploadScript } from "../../src/native/ui/upload.ts";

async function publish(files: File[], failFinalize = false) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetch = async (path: string, init: RequestInit = {}) => {
    calls.push({ path, init });
    if (path === "/api/session") return Response.json({ csrfToken: "session-csrf" });
    assert.equal(new Headers(init.headers).get("X-Shlook-CSRF"), "session-csrf");
    if (path === "/api/assets") return Response.json({ asset: { id: "publication" } });
    if (init.method === "PUT")
      return Response.json({ file: { uploadId: "uploaded-" + calls.length } });
    if (path.endsWith("/finalize") && failFinalize)
      return Response.json({ error: "finalize_failed" }, { status: 400 });
    return Response.json({});
  };
  const run = new Function(
    "files",
    "fetch",
    `return (async () => {
    const document = { querySelector: () => null };
    const uploadForm = { querySelector: () => null, dataset: { privateOrigin: '' } };
    const uploadName = { value: 'Test', dataset: {} }, uploadDescription = { value: '' };
    const errorMessage = value => value;
    const chooseUploadFile = () => {}, setUploadProgress = () => {};
    ${nativeRequestScript()}
    ${nativeUploadScript()}
    chooseUploadFiles(files);
    try { return { result: await publishUpload(), error: null }; }
    catch (error) { return { result: null, error: error.message }; }
  })();`,
  );
  return { ...(await run(files, fetch)), calls };
}

test("native upload converts a single Markdown safely and CSRF-protects create/PUT/finalize", async () => {
  const { result, calls, error } = await publish([
    new File(["# Note\n<script>alert(1)</script>"], "note.md"),
  ]);
  assert.equal(error, null);
  assert.equal(result.resultUrl, "/assets/publication/");
  const mutations = calls.filter((call) => call.path !== "/api/session");
  assert.deepEqual(
    mutations.map((call) => call.init.method),
    ["POST", "PUT", "POST"],
  );
  assert.equal(calls.filter((call) => call.path === "/api/session").length, mutations.length);
  const uploaded = mutations[1];
  assert.ok(uploaded.path.endsWith("/note.md.html"));
  const content = new TextDecoder().decode(uploaded.init.body as Uint8Array);
  assert.ok(content.includes("&lt;script&gt;"));
  assert.ok(!content.includes("<script>"));
  const finalization = JSON.parse(mutations[2].init.body as string);
  assert.equal(finalization.entrypoint, "note.md.html");
  assert.deepEqual(
    finalization.files.map((file: any) => file.path),
    ["note.md.html"],
  );
});

test("directory Markdown remains inert and image upload retains wrapper", async () => {
  const file = new File(["# Do not render"], "readme.md");
  Object.defineProperty(file, "webkitRelativePath", { value: "notes/readme.md" });
  const directory = await publish([file]);
  assert.equal(directory.error, null);
  const puts = directory.calls.filter((call) => call.init.method === "PUT");
  assert.ok(puts[0].path.endsWith("/notes/readme.md"));
  assert.equal(new TextDecoder().decode(puts[0].init.body as Uint8Array), "# Do not render");
  assert.ok(puts[1].path.endsWith("/index.html"));
  const image = await publish([new File([new Uint8Array([1, 2])], 'a".png')]);
  assert.equal(image.error, null);
  const wrapper = image.calls.find((call) => call.path.endsWith("/files/index.html"))!;
  assert.ok(
    new TextDecoder().decode(wrapper.init.body as Uint8Array).includes('alt="a&quot;.png"'),
  );
});

test("failed finalization cleans up through the same CSRF seam; preparation rejects MDX and excessive files before creating", async () => {
  const failed = await publish([new File(["<h1>Test</h1>"], "index.html")], true);
  assert.equal(failed.error, "finalize_failed");
  assert.equal(failed.calls.at(-1)?.init.method, "DELETE");
  for (const files of [
    [new File(["export default 1"], "note.mdx")],
    Array.from({ length: 501 }, () => new File(["x"], "index.html")),
  ]) {
    const invalid = await publish(files);
    assert.ok(invalid.error);
    assert.deepEqual(invalid.calls, []);
  }
});

test("native preparation rejects oversized and invalid UTF-8 inputs before creation", async () => {
  const oversized = new File([], "index.html");
  Object.defineProperty(oversized, "size", { value: 25 * 1024 * 1024 + 1 });
  for (const file of [oversized, new File([new Uint8Array([0xff])], "note.md")]) {
    const result = await publish([file]);
    assert.ok(result.error);
    assert.deepEqual(result.calls, []);
  }
});

test("native transport protects single/batch deletion, expiry and logout without changing reads", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetch = async (path: string, init: RequestInit = {}) => {
    calls.push({ path, init });
    return Response.json(path === "/api/session" && !init.method ? { csrfToken: "csrf" } : {});
  };
  await new Function(
    "fetch",
    `return (async () => {
    const document = { querySelector: () => null }, errorMessage = value => value;
    ${nativeRequestScript()}
    await ownerRequest('/api/assets');
    await ownerRequest('/api/assets/one', { method: 'DELETE' });
    await Promise.all(['two','three'].map(id => ownerRequest('/api/assets/' + id, { method: 'DELETE' })));
    await ownerRequest('/api/assets/one/expiry', { method: 'PATCH', body: JSON.stringify({ hardExpiresAt: null }) });
    await ownerRequest('/api/session', { method: 'DELETE' });
  })();`,
  )(fetch);
  const mutations = calls.filter((call) => call.init.method);
  assert.equal(mutations.length, 5);
  assert.equal(calls.filter((call) => call.path === "/api/session" && !call.init.method).length, 5);
  for (const call of mutations)
    assert.equal(new Headers(call.init.headers).get("X-Shlook-CSRF"), "csrf");
  assert.equal(new Headers(calls[0].init.headers).has("X-Shlook-CSRF"), false);
});

test("native logout protects its entire session exchange from passive archive refresh", async () => {
  let logout: (event: unknown) => Promise<void>;
  let operations = 0;
  let destination = "";
  const fetch = async (path: string, init: RequestInit = {}) => {
    assert.equal(path, "/api/session");
    assert.equal(operations, 1);
    return Response.json(init.method ? {} : { csrfToken: "csrf" });
  };
  new Function(
    "fetch",
    "document",
    "location",
    "beginArchiveOperation",
    "setStatus",
    "errorMessage",
    nativeRequestScript(),
  )(
    fetch,
    {
      querySelector: () => ({
        addEventListener: (_type: string, callback: typeof logout) => {
          logout = callback;
        },
      }),
    },
    {
      replace: (path: string) => {
        destination = path;
      },
    },
    () => {
      operations++;
      return () => {
        operations--;
      };
    },
    () => {},
    (value: string) => value,
  );
  await logout!({ currentTarget: { disabled: false } });
  assert.equal(operations, 0);
  assert.equal(destination, "/login");
});

test("native requests recover expired sessions through document navigation, not API redirects", async () => {
  for (const failure of ["session", "mutation", "read", "forbidden"]) {
    let reloads = 0;
    const fetch = async (path: string) => {
      if (failure === "session" || failure === "read") return new Response(null, { status: 401 });
      if (path === "/api/session") return Response.json({ csrfToken: "csrf" });
      return new Response(null, { status: failure === "forbidden" ? 403 : 401 });
    };
    await new Function(
      "fetch",
      "location",
      "read",
      `return (async () => {
      const document = { querySelector: () => null }, errorMessage = value => value;
      ${nativeRequestScript()}
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await ownerRequest('/api/assets/one', read ? {} : { method: 'DELETE' }); }
        catch {}
      }
    })();`,
    )(
      fetch,
      {
        reload: () => {
          reloads++;
        },
      },
      failure === "read",
    );
    assert.equal(reloads, failure === "forbidden" ? 0 : 1, failure);
  }
});

test("native previews resolve nested entrypoints once, encoding paths and retaining the canonical iframe seam", async () => {
  let requests = 0;
  const media = () => {
    const frame = { dataset: { src: "" } };
    return {
      dataset: { previewEntrypoint: "asset" },
      isConnected: true,
      parentElement: { querySelector: () => frame },
      src: "",
      frame,
    };
  };
  const images = [media(), media()];
  await new Function(
    "images",
    "ownerRequest",
    `return (async () => {
    ${nativePreviewScript()}
    await Promise.all(images.map(resolvePreview));
  })();`,
  )(images, async () => {
    requests++;
    return { asset: { entrypoint: 'folder/a "b".html' } };
  });
  assert.equal(requests, 1);
  for (const image of images) {
    assert.equal(image.src, "/preview/assets/asset/folder/a%20%22b%22.html");
    assert.equal(image.frame.dataset.src, image.src);
  }
});

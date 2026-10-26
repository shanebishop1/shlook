import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, createServer as createHttpsServer } from "node:https";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "@playwright/test";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const secondHost = process.platform === "darwin" ? "::1" : "127.0.0.2";
const secondAuthority = secondHost.includes(":") ? `[${secondHost}]` : secondHost;

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repo,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${basename(command)} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
}

function parseJsonOutput(stdout: string) {
  const lines = stdout.trim().split("\n");
  const result = JSON.parse(lines.at(-1) ?? "null") as {
    ok?: boolean;
    data?: unknown;
    error?: unknown;
  };
  assert.equal(result.ok, true, `CLI command failed: ${stdout}`);
  return result.data;
}

function cli(
  pkg: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<unknown> {
  return new Promise((resolveCli, rejectCli) => {
    const child = spawn(process.execPath, [join(pkg, "dist/cli.js"), ...args, "--json"], {
      cwd: pkg,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectCli(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const instance = args.indexOf("--instance");
        const label = instance < 0 ? args[0] : `${args[0]} (${args[instance + 1]})`;
        rejectCli(new Error(`packed CLI ${label} failed (${code}): ${stderr}`));
        return;
      }
      try {
        resolveCli(parseJsonOutput(stdout));
      } catch (error) {
        rejectCli(error);
      }
    });
    child.stdin.end(input);
  });
}

function serverCommand(pkg: string, args: string[], env: NodeJS.ProcessEnv) {
  return run(process.execPath, [join(pkg, "dist/native/main.js"), ...args], { cwd: pkg, env });
}

function launchServer(pkg: string, dataDir: string, env: NodeJS.ProcessEnv) {
  const child = spawn(
    process.execPath,
    [join(pkg, "dist/native/main.js"), "start", "--data-dir", dataDir, "--port", "0"],
    {
      cwd: pkg,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ready = new Promise<number>((resolvePort, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`packaged server did not start: ${stderr}`)),
      15_000,
    );
    child.stderr.on("data", () => {
      const match = /shlook-server listening on 127\.0\.0\.1:(\d+)/.exec(stderr);
      if (match) {
        clearTimeout(timeout);
        resolvePort(Number(match[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`packaged server exited before ready (${code}): ${stderr}`));
    });
    child.once("error", reject);
  });
  return {
    child,
    ready,
    get stderr() {
      return stderr;
    },
  };
}

async function stopServer(child: ReturnType<typeof launchServer>["child"]) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), 10_000);
  });
  if ((await Promise.race([exited.then(() => "exit" as const), timedOut])) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
  if (timer) clearTimeout(timer);
}

function adminIssue(
  pkg: string,
  user: string,
  name: string,
  role: string,
  tokenFile: string,
  dataDir: string,
  env: NodeJS.ProcessEnv,
) {
  return serverCommand(
    pkg,
    [
      "token",
      "issue",
      "--user",
      user,
      "--name",
      name,
      "--role",
      role,
      "--token-file",
      tokenFile,
      "--data-dir",
      dataDir,
    ],
    env,
  );
}

function proxyResponse(port: number, connectHost: string, host: string, path: string, ca: Buffer) {
  return new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
    const request = httpsRequest(
      { host: connectHost, port, path, headers: { Host: host }, ca, rejectUnauthorized: true },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolveResponse({ status: response.statusCode ?? 0, body }));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test(
  "packed production bins operate independently of the checkout",
  {
    timeout: 180_000,
  },
  async (t) => {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "shlook-packed-native-")));
    const packed = join(temp, "packed");
    const unpacked = join(temp, "package");
    const xdg = join(temp, "xdg");
    const data = join(temp, "data");
    const proxyFiles = join(temp, "proxy");
    const browserProfile = join(temp, "browser-profile");
    mkdirSync(packed, { mode: 0o700 });
    mkdirSync(xdg, { mode: 0o700 });
    mkdirSync(proxyFiles, { mode: 0o700 });
    let server: ReturnType<typeof launchServer> | undefined;
    let secondServer: ReturnType<typeof launchServer> | undefined;
    let proxy: ReturnType<typeof createHttpsServer> | undefined;
    let aliasProxy: ReturnType<typeof createHttpsServer> | undefined;
    let secondProxy: ReturnType<typeof createHttpsServer> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
    try {
      run("npm", ["pack", "--ignore-scripts", "--pack-destination", packed]);
      const tarball = join(
        packed,
        readdirSync(packed).find((entry) => entry.endsWith(".tgz"))!,
      );
      mkdirSync(unpacked, { mode: 0o700 });
      run("tar", ["-xzf", tarball, "-C", unpacked]);
      const pkg = join(unpacked, "package");
      for (const required of [
        "dist/native/main.js",
        "dist/native/ui/index.js",
        "dist/cli.js",
        "dist/native/router.js",
        "dist/native/store.js",
      ])
        assert.ok(existsSync(join(pkg, required)), `packed package is missing ${required}`);
      const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as {
        bin: Record<string, string>;
      };
      assert.equal(manifest.bin.shlook, "dist/cli.js");
      assert.equal(manifest.bin["shlook-server"], "dist/native/main.js");
      copyFileSync(join(repo, "pnpm-lock.yaml"), join(pkg, "pnpm-lock.yaml"));
      run("pnpm", [
        "install",
        "--offline",
        "--prod",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--dir",
        pkg,
      ]);
      assert.equal(statSync(join(pkg, "dist/native/main.js")).mode & 0o111, 0o111);

      const env: NodeJS.ProcessEnv = { ...process.env, HOME: temp, XDG_CONFIG_HOME: xdg };
      for (const key of Object.keys(env))
        if (/^(?:CF_ACCESS_|SHLOOK_API_TOKEN_|SHLOOK_INSTANCE$)/.test(key)) delete env[key];
      const keyFile = join(proxyFiles, "key.pem");
      const certFile = join(proxyFiles, "cert.pem");
      writeFileSync(
        join(proxyFiles, "openssl.cnf"),
        [
          "[req]",
          "distinguished_name=dn",
          "x509_extensions=ext",
          "prompt=no",
          "",
          "[dn]",
          "CN=localhost",
          "",
          "[ext]",
          "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:127.0.0.2,IP:::1",
          "basicConstraints=critical,CA:TRUE",
          "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
          "",
        ].join("\n"),
      );
      run("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-config",
        join(proxyFiles, "openssl.cnf"),
      ]);
      env.NODE_EXTRA_CA_CERTS = certFile;
      let primaryUpstreamPort = 0;
      let secondaryUpstreamPort = 0;
      const listenProxy = async (bindHost: string, upstream: () => number, port = 0) => {
        const instance = createHttpsServer(
          { key: readFileSync(keyFile), cert: readFileSync(certFile) },
          (request, response) => {
            const port = upstream();
            if (!port) {
              response.writeHead(503).end();
              return;
            }
            const authority = request.headers.host ?? "";
            const forwarding = httpRequest(
              {
                host: "127.0.0.1",
                port,
                method: request.method,
                path: request.url,
                headers: { ...request.headers, host: authority },
              },
              (upstreamResponse) => {
                response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
                upstreamResponse.pipe(response);
              },
            );
            forwarding.once("error", () => {
              if (!response.headersSent) response.writeHead(502);
              response.end();
            });
            request.pipe(forwarding);
          },
        );
        await new Promise<void>((resolveListen, rejectListen) => {
          instance.once("error", rejectListen);
          instance.listen(port, bindHost, resolveListen);
        });
        return instance;
      };
      proxy = await listenProxy("127.0.0.1", () => primaryUpstreamPort);
      const proxyAddress = proxy.address();
      assert.ok(proxyAddress && typeof proxyAddress === "object");
      const tlsPort = proxyAddress.port;
      if (process.platform === "darwin")
        aliasProxy = await listenProxy("::1", () => primaryUpstreamPort, tlsPort);
      secondProxy = await listenProxy(secondHost, () => secondaryUpstreamPort);
      const secondProxyAddress = secondProxy.address();
      assert.ok(secondProxyAddress && typeof secondProxyAddress === "object");
      const secondTlsPort = secondProxyAddress.port;
      const canonical = `https://127.0.0.1:${tlsPort}`;
      const alias = `https://localhost:${tlsPort}`;
      const secondOrigin = `https://${secondAuthority}:${secondTlsPort}`;

      serverCommand(
        pkg,
        ["init", "--data-dir", data, "--origin", canonical, "--alias", alias],
        env,
      );
      serverCommand(
        pkg,
        ["user", "add", "alice", "--display-name", "Alice", "--data-dir", data],
        env,
      );
      serverCommand(pkg, ["user", "add", "bob", "--display-name", "Bob", "--data-dir", data], env);
      const firstTokenFile = join(temp, "alice-primary.token");
      const aliasTokenFile = join(temp, "alice-alias.token");
      const viewerTokenFile = join(temp, "bob-viewer.token");
      adminIssue(pkg, "alice", "primary", "publisher", firstTokenFile, data, env);
      adminIssue(pkg, "alice", "alias", "publisher", aliasTokenFile, data, env);
      adminIssue(pkg, "bob", "reader", "viewer", viewerTokenFile, data, env);
      for (const tokenFile of [firstTokenFile, aliasTokenFile, viewerTokenFile])
        assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
      const firstToken = readFileSync(firstTokenFile, "utf8").trim();
      const aliasToken = readFileSync(aliasTokenFile, "utf8").trim();
      const viewerToken = readFileSync(viewerTokenFile, "utf8").trim();

      server = launchServer(pkg, data, env);
      primaryUpstreamPort = await server.ready;
      const tlsHealth = await proxyResponse(
        tlsPort,
        "127.0.0.1",
        `127.0.0.1:${tlsPort}`,
        "/health",
        readFileSync(certFile),
      );
      assert.equal(tlsHealth.status, 401);
      if (process.platform === "darwin") {
        const aliasHealth = await proxyResponse(
          tlsPort,
          "::1",
          `localhost:${tlsPort}`,
          "/health",
          readFileSync(certFile),
        );
        assert.equal(aliasHealth.status, 401);
      }
      const addPrimary = (await cli(
        pkg,
        ["instance", "add", "primary", "--url", canonical],
        env,
      )) as {
        name?: string;
      };
      assert.equal(addPrimary.name, "primary");
      await cli(pkg, ["connect", "--instance", "primary"], env, `${firstToken}\n`);
      await cli(pkg, ["instance", "add", "alias", "--url", alias], env);
      await cli(pkg, ["connect", "--instance", "alias"], env, `${aliasToken}\n`);
      await cli(pkg, ["instance", "add", "reader", "--url", canonical], env);
      await cli(pkg, ["connect", "--instance", "reader"], env, `${viewerToken}\n`);

      const publishDir = join(temp, "publish");
      mkdirSync(join(publishDir, "nested"), { recursive: true });
      writeFileSync(
        join(publishDir, "nested", "index.html"),
        '<!doctype html><h1>Packaged native</h1><link rel="stylesheet" href="style.css"><script src="app.js"></script><img src="image.png">',
      );
      writeFileSync(join(publishDir, "nested", "app.js"), "document.body.dataset.packaged='yes';");
      writeFileSync(join(publishDir, "nested", "style.css"), "body { color: rgb(1, 2, 3) }");
      writeFileSync(
        join(publishDir, "nested", "image.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5Z8AAAAASUVORK5CYII=",
          "base64",
        ),
      );
      writeFileSync(join(publishDir, "notes.md"), "# Packaged Markdown\n\n- tested");
      const publication = (await cli(
        pkg,
        [
          "publish",
          publishDir,
          "--name",
          "Packaged site",
          "--entrypoint",
          "nested/index.html",
          "--instance",
          "primary",
        ],
        env,
      )) as { url?: string; asset?: { id: string } };
      const assetId = publication.asset?.id;
      assert.ok(assetId, "publish should return an asset id");
      assert.match(publication.url ?? "", new RegExp(`^${canonical}/assets/`));
      const markdown = (await cli(
        pkg,
        [
          "publish",
          join(publishDir, "notes.md"),
          "--name",
          "Packaged notes",
          "--instance",
          "primary",
        ],
        env,
      )) as { asset?: { id: string } };
      assert.ok(markdown.asset?.id);
      const rasterFile = join(temp, "standalone.png");
      writeFileSync(
        rasterFile,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5Z8AAAAASUVORK5CYII=",
          "base64",
        ),
      );
      const raster = (await cli(
        pkg,
        ["publish", rasterFile, "--name", "Standalone raster", "--instance", "primary"],
        env,
      )) as { asset?: { id: string }; url?: string };
      assert.ok(raster.asset?.id);
      assert.match(raster.url ?? "", new RegExp(`^${canonical}/assets/`));
      const rasterVerification = (await cli(
        pkg,
        ["verify", raster.asset.id, "--instance", "primary"],
        env,
      )) as { assetId?: string; verified?: boolean; status?: number };
      assert.equal(rasterVerification.assetId, raster.asset.id);
      assert.equal(rasterVerification.verified, true);
      assert.equal(rasterVerification.status, 200);
      const aliasMarkdown = (await cli(
        pkg,
        ["publish", join(publishDir, "notes.md"), "--name", "Alias notes", "--instance", "alias"],
        env,
      )) as { url?: string };
      assert.match(aliasMarkdown.url ?? "", new RegExp(`^${alias}/assets/`));
      const aliasList = (await cli(pkg, ["list", "--instance", "alias"], env)) as {
        assets?: Array<{ id: string }>;
      };
      assert.ok(
        aliasList.assets?.some((asset) => asset.id === assetId),
        "aliases share instance data",
      );
      const readerList = (await cli(pkg, ["list", "--instance", "reader"], env)) as {
        assets?: Array<{ id: string }>;
      };
      assert.ok(
        readerList.assets?.some((asset) => asset.id === assetId),
        "viewer reads shared publications",
      );
      const verify = (await cli(pkg, ["verify", assetId, "--instance", "primary"], env)) as {
        assetId?: string;
        verified?: boolean;
        status?: number;
      };
      assert.equal(verify.assetId, assetId);
      assert.equal(verify.verified, true);
      assert.equal(verify.status, 200);
      await assert.rejects(
        cli(pkg, ["visibility", assetId, "public", "--instance", "primary"], env),
      );
      const stillPrivate = (await cli(pkg, ["show", assetId, "--instance", "primary"], env)) as {
        asset?: { id?: string; visibility?: string };
      };
      assert.equal(stillPrivate.asset?.id, assetId);
      assert.equal(stillPrivate.asset?.visibility, "private");
      await assert.rejects(cli(pkg, ["delete", assetId, "--instance", "reader"], env));
      const expiryFile = join(temp, "expiry.html");
      writeFileSync(expiryFile, "<h1>expires</h1>");
      const expiring = (await cli(
        pkg,
        ["publish", expiryFile, "--name", "Expiring", "--instance", "primary"],
        env,
      )) as { asset?: { id: string } };
      assert.ok(expiring.asset?.id);
      await cli(
        pkg,
        ["hard", "expiry", expiring.asset.id, "2000-01-01T00:00:00.000Z", "--instance", "primary"],
        env,
      );
      await assert.rejects(cli(pkg, ["show", expiring.asset!.id, "--instance", "primary"], env));
      await cli(pkg, ["delete", expiring.asset.id, "--instance", "primary"], env);

      const profileBrowser = await chromium.launchPersistentContext(browserProfile, {
        headless: true,
        ignoreHTTPSErrors: true,
      });
      browser = profileBrowser;
      const page = await browser.newPage();
      await page.goto(`${canonical}/login`);
      await page.locator('input[type="password"]').fill(firstToken);
      await page.getByRole("button", { name: /sign in|log in|login/i }).click();
      await page.waitForURL((url) => url.origin === canonical);
      await page.getByText("Packaged site").waitFor();
      const browserSession = await page.context().cookies(canonical);
      assert.ok(
        browserSession.some(
          (cookie) =>
            cookie.name === "__Host-shlook_session" && cookie.httpOnly && cookie.expires > 0,
        ),
      );
      const artifact = await page.goto(`${canonical}/assets/${assetId}/`);
      assert.equal(artifact?.status(), 200);
      assert.match(page.url(), new RegExp(`/assets/${assetId}/nested/index.html$`));
      await browser.close();
      browser = undefined;

      await stopServer(server.child);
      server = launchServer(pkg, data, env);
      primaryUpstreamPort = await server.ready;
      browser = await chromium.launchPersistentContext(browserProfile, {
        headless: true,
        ignoreHTTPSErrors: true,
      });
      const resumed = await browser.newPage();
      await resumed.goto(`${canonical}/archive`);
      await resumed.getByText("Packaged site").waitFor();

      const listedTokens = JSON.parse(
        serverCommand(pkg, ["token", "list", "--user", "alice", "--data-dir", data], env),
      );
      const primaryTokenId = listedTokens.find(
        (entry: { name: string }) => entry.name === "primary",
      ).id as string;
      serverCommand(pkg, ["token", "revoke", primaryTokenId, "--data-dir", data], env);
      await assert.rejects(cli(pkg, ["list", "--instance", "primary"], env));
      assert.ok(
        ((await cli(pkg, ["list", "--instance", "alias"], env)) as { assets?: unknown[] }).assets
          ?.length,
      );
      await resumed.goto(`${canonical}/archive`);
      await resumed.waitForURL(/\/login/);

      const data2 = join(temp, "data-2");
      serverCommand(pkg, ["init", "--data-dir", data2, "--origin", secondOrigin], env);
      serverCommand(
        pkg,
        ["user", "add", "alice", "--display-name", "Other Alice", "--data-dir", data2],
        env,
      );
      const token2File = join(temp, "other.token");
      adminIssue(pkg, "alice", "other", "publisher", token2File, data2, env);
      secondServer = launchServer(pkg, data2, env);
      secondaryUpstreamPort = await secondServer.ready;
      await cli(pkg, ["instance", "add", "other", "--url", secondOrigin], env);
      const otherToken = readFileSync(token2File, "utf8").trim();
      await cli(pkg, ["connect", "--instance", "other"], env, `${otherToken}\n`);
      const invalidCredentialEnv = { ...env, SHLOOK_API_TOKEN_OTHER: aliasToken };
      await assert.rejects(cli(pkg, ["list", "--instance", "other"], invalidCredentialEnv));
      const secondList = (await cli(pkg, ["list", "--instance", "other"], env)) as {
        assets?: unknown[];
      };
      assert.equal(
        secondList.assets?.length,
        0,
        "second data directory has no cross-instance publications",
      );
      const aliasLogin = await browser.newPage();
      await aliasLogin.goto(`${alias}/login`);
      await aliasLogin.locator('input[type="password"]').fill(aliasToken);
      await aliasLogin.getByRole("button", { name: /sign in|log in|login/i }).click();
      await aliasLogin.getByText("Packaged site").waitFor();
      const isolatedHostPage = await browser.newPage();
      await isolatedHostPage.goto(`${secondOrigin}/archive`);
      await isolatedHostPage.waitForURL(/\/login/);
      await cli(pkg, ["delete", assetId, "--instance", "alias"], env);
      await assert.rejects(cli(pkg, ["show", assetId, "--instance", "alias"], env));
      await aliasLogin.goto(`${alias}/archive`);
      await aliasLogin.getByText("Packaged site").waitFor({ state: "detached" });
      serverCommand(pkg, ["user", "disable", "bob", "--data-dir", data], env);
      await assert.rejects(cli(pkg, ["list", "--instance", "reader"], env));
      serverCommand(pkg, ["user", "disable", "alice", "--data-dir", data], env);
      await assert.rejects(cli(pkg, ["list", "--instance", "primary"], env));
      await assert.rejects(cli(pkg, ["list", "--instance", "alias"], env));
      await aliasLogin.goto(`${alias}/archive`);
      await aliasLogin.waitForURL(/\/login/);
      await browser.close();
      browser = undefined;
      const isolated = await proxyResponse(
        secondTlsPort,
        secondHost,
        `${secondAuthority}:${secondTlsPort}`,
        "/api/assets",
        readFileSync(certFile),
      );
      assert.equal(isolated.status, 401);
      assert.ok(!server.stderr.includes(firstToken) && !server.stderr.includes(aliasToken));
      assert.ok(!secondServer.stderr.includes(readFileSync(token2File, "utf8").trim()));
      await t.test("packaged database is independent from the source checkout", () => {
        assert.ok(!existsSync(join(pkg, "src/native/main.ts")));
        assert.ok(existsSync(join(pkg, "node_modules/parse5")));
      });
    } finally {
      if (browser) await browser.close().catch(() => undefined);
      if (server) await stopServer(server.child).catch(() => server?.child.kill("SIGKILL"));
      if (secondServer)
        await stopServer(secondServer.child).catch(() => secondServer?.child.kill("SIGKILL"));
      if (proxy?.listening)
        await new Promise<void>((resolveClose) => proxy!.close(() => resolveClose()));
      if (aliasProxy?.listening)
        await new Promise<void>((resolveClose) => aliasProxy!.close(() => resolveClose()));
      if (secondProxy?.listening)
        await new Promise<void>((resolveClose) => secondProxy!.close(() => resolveClose()));
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

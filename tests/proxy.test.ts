import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { fetch as undiciFetch } from "undici";
import { UsageDispatcherPool, usageProxyConfigured } from "../usage.server";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to TCP");
  return address.port;
}

test("selects proxy or direct transport and honors NO_PROXY", async () => {
  let proxyConnections = 0;
  const origin = createServer((_request, response) => response.end("origin"));
  const proxy = createServer((_request, response) => {
    proxyConnections += 1;
    response.end("proxy");
  });
  proxy.on("connect", (request, clientSocket, initialData) => {
    proxyConnections += 1;
    const target = new URL(`http://${request.url}`);
    const serverSocket = connect(Number(target.port), target.hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (initialData.length) serverSocket.write(initialData);
      clientSocket.pipe(serverSocket);
      serverSocket.pipe(clientSocket);
    });
    serverSocket.on("error", () => clientSocket.destroy());
  });

  const pools: UsageDispatcherPool[] = [];
  try {
    const [originPort, proxyPort] = await Promise.all([listen(origin), listen(proxy)]);
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    const environment = {
      http_proxy: "",
      HTTP_PROXY: proxyUrl,
      https_proxy: "",
      HTTPS_PROXY: proxyUrl,
      no_proxy: "",
      NO_PROXY: "",
    };
    const proxiedPool = new UsageDispatcherPool(environment);
    pools.push(proxiedPool);
    const url = `http://127.0.0.1:${originPort}/usage`;

    const direct = await undiciFetch(url, { dispatcher: proxiedPool.dispatcher(false) });
    assert.equal(await direct.text(), "origin");
    assert.equal(proxyConnections, 0);

    await undiciFetch(url, { dispatcher: proxiedPool.dispatcher(true) });
    assert.ok(proxyConnections > 0);

    const connectionsBeforeNoProxy = proxyConnections;
    const bypassPool = new UsageDispatcherPool({ ...environment, NO_PROXY: "127.0.0.1" });
    pools.push(bypassPool);
    const bypassed = await undiciFetch(url, { dispatcher: bypassPool.dispatcher(true) });
    assert.equal(await bypassed.text(), "origin");
    assert.equal(proxyConnections, connectionsBeforeNoProxy);

    assert.equal(usageProxyConfigured({}), false);
    assert.equal(usageProxyConfigured(environment), true);
  } finally {
    await Promise.all(pools.map((pool) => pool.close()));
    await Promise.all([
      new Promise<void>((resolve) => origin.close(() => resolve())),
      new Promise<void>((resolve) => proxy.close(() => resolve())),
    ]);
  }
});

test("invalid proxy configuration does not block direct transport", async () => {
  const pool = new UsageDispatcherPool({ HTTPS_PROXY: "://invalid" });
  try {
    assert.equal(pool.dispatcher(false), pool.direct);
    assert.throws(() => pool.dispatcher(true), /proxy configuration is invalid/i);
  } finally {
    await pool.close();
  }
});

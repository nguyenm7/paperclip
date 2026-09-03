import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { drainHttpServer } from "./gateway-lifecycle.js";

describe("product feedback gateway lifecycle", () => {
  it("waits for an active request before completing shutdown", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let finishRequest!: () => void;
    const finish = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    const server = createServer(async (_request, response) => {
      requestStarted();
      await finish;
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");

    const responsePromise = fetch(`http://127.0.0.1:${address.port}`);
    await started;
    let drained = false;
    const drainPromise = drainHttpServer(server).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finishRequest();
    await expect(responsePromise.then((response) => response.text())).resolves.toBe("ok");
    await drainPromise;
    expect(drained).toBe(true);
  });
});

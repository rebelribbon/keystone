import { describe, it, expect, afterEach, vi } from "vitest";
import { callServer, isServerError, RETRY_DELAY_MS } from "../src/client/persistence/transport.js";

// google.script.run is the only server surface the client has (SPEC §14.2), so
// the retry policy is tested against a fake of it rather than against the
// wrapper's internals: what matters is how many round trips actually happen.
function installRunner(responses) {
  const calls = [];
  const runner = {};
  let onSuccess = null;
  let onFailure = null;

  const api = {
    withSuccessHandler(fn) {
      onSuccess = fn;
      return api;
    },
    withFailureHandler(fn) {
      onFailure = fn;
      return api;
    },
  };

  for (const name of Object.keys(responses)) {
    api[name] = (...args) => {
      calls.push({ name, args });
      const queue = responses[name];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      // Apps Script answers asynchronously; keeping that shape means the retry
      // path is exercised through real promise scheduling.
      Promise.resolve().then(() => {
        if (next && next.fail) onFailure(next.fail);
        else onSuccess(next && "result" in next ? next.result : next);
      });
    };
  }

  Object.assign(runner, api);
  globalThis.google = { script: { run: runner } };
  return calls;
}

afterEach(() => {
  delete globalThis.google;
  vi.useRealTimers();
});

describe("isServerError", () => {
  it("recognizes the { code, message } contract and nothing else", () => {
    expect(isServerError({ code: "ACCESS_DENIED", message: "no" })).toBe(true);
    expect(isServerError({ code: 1, message: "no" })).toBe(false);
    expect(isServerError({ email: "a@b.com", role: "owner" })).toBe(false);
    expect(isServerError(null)).toBe(false);
  });
});

describe("callServer retry policy (ticket 006 §3)", () => {
  it("retries AUTH_UNAVAILABLE exactly once and returns the second answer", async () => {
    const calls = installRunner({
      api_whoami: [
        { result: { code: "AUTH_UNAVAILABLE", message: "could not check the access list" } },
        { result: { email: "owner@example.com", role: "owner" } },
      ],
    });

    const result = await callServer("api_whoami", [], { retryDelayMs: 0 });
    expect(result).toEqual({ email: "owner@example.com", role: "owner" });
    expect(calls).toHaveLength(2);
  });

  it("gives up after one retry rather than looping", async () => {
    const calls = installRunner({
      api_whoami: [{ result: { code: "AUTH_UNAVAILABLE", message: "still down" } }],
    });

    await expect(callServer("api_whoami", [], { retryDelayMs: 0 })).rejects.toMatchObject({
      code: "AUTH_UNAVAILABLE",
      fromServer: true,
    });
    expect(calls).toHaveLength(2);
  });

  it("does not retry ACCESS_DENIED", async () => {
    const calls = installRunner({
      api_whoami: [{ result: { code: "ACCESS_DENIED", message: "not on the list" } }],
    });

    await expect(callServer("api_whoami", [], { retryDelayMs: 0 })).rejects.toMatchObject({
      code: "ACCESS_DENIED",
      fromServer: true,
    });
    // A denial is an answer. Asking again produces the same answer and one more
    // round trip, and tells the person nothing they did not already know.
    expect(calls).toHaveLength(1);
  });

  it("does not retry any other structured server error", async () => {
    for (const code of ["CHUNK_TOO_LARGE", "BUILD_NOT_FOUND", "FORBIDDEN", "INTERNAL"]) {
      const calls = installRunner({ api_whoami: [{ result: { code, message: code } }] });
      await expect(callServer("api_whoami", [], { retryDelayMs: 0 })).rejects.toMatchObject({ code });
      expect(calls, code).toHaveLength(1);
      delete globalThis.google;
    }
  });

  it("still retries a transport failure once, immediately", async () => {
    const calls = installRunner({
      api_whoami: [{ fail: new Error("network blip") }, { result: { email: "a@b.com", role: "viewer" } }],
    });
    const result = await callServer("api_whoami", []);
    expect(result).toEqual({ email: "a@b.com", role: "viewer" });
    expect(calls).toHaveLength(2);
  });

  it("honors retry: false for AUTH_UNAVAILABLE too", async () => {
    const calls = installRunner({
      api_whoami: [{ result: { code: "AUTH_UNAVAILABLE", message: "down" } }],
    });
    await expect(callServer("api_whoami", [], { retry: false })).rejects.toMatchObject({
      code: "AUTH_UNAVAILABLE",
    });
    expect(calls).toHaveLength(1);
  });

  it("waits before the AUTH_UNAVAILABLE retry, so an instant second call cannot happen", async () => {
    vi.useFakeTimers();
    const calls = installRunner({
      api_whoami: [
        { result: { code: "AUTH_UNAVAILABLE", message: "down" } },
        { result: { email: "owner@example.com", role: "owner" } },
      ],
    });

    const pending = callServer("api_whoami", []);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(calls).toHaveLength(2);
    await expect(pending).resolves.toEqual({ email: "owner@example.com", role: "owner" });
  });
});

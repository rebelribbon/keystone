import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// The Builder cannot deploy or run Apps Script from a cloud session, so the
// server's decision logic is tested by evaluating the .gs files as text in a
// sandbox with stubbed Apps Script globals (ticket 002, "Constraint").
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STORAGE_SRC = readFileSync(join(root, "src/server/Storage.gs"), "utf8");
const CODE_SRC = readFileSync(join(root, "src/server/Code.gs"), "utf8");

const SETTINGS_HEADER = ["key", "value"];
const USERS_HEADER = ["email", "role", "addedOn"];

/**
 * Evaluate Storage.gs then Code.gs in one sandbox and hand back the globals
 * plus the fakes, so tests can assert on cache writes and Log rows.
 */
function createServer(options = {}) {
  const {
    settingsRows = [SETTINGS_HEADER],
    usersRows = [USERS_HEADER],
    email = "",
    serviceUrl = "https://script.google.com/macros/s/AKfy/dev",
    fetchImpl = () => ({ code: 404, body: "" }),
  } = options;

  const store = new Map();
  const logRows = [];
  const fetches = [];

  const sheets = {
    Settings: { getDataRange: () => ({ getValues: () => settingsRows }) },
    Users: { getDataRange: () => ({ getValues: () => usersRows }) },
    Log: { appendRow: (row) => logRows.push(row) },
  };

  const cache = {
    get: (k) => (store.has(k) ? store.get(k) : null),
    put: (k, v) => store.set(k, String(v)),
    remove: (k) => store.delete(k),
    getAll: (keys) => {
      const out = {};
      for (const k of keys) if (store.has(k)) out[k] = store.get(k);
      return out;
    },
    putAll: (obj) => {
      for (const k of Object.keys(obj)) store.set(k, String(obj[k]));
    },
  };

  const sandbox = {
    console,
    SpreadsheetApp: {
      getActive: () => ({ getSheetByName: (name) => sheets[name] || null }),
    },
    CacheService: { getScriptCache: () => cache },
    Session: { getActiveUser: () => ({ getEmail: () => email }) },
    ScriptApp: { getService: () => ({ getUrl: () => serviceUrl }) },
    UrlFetchApp: {
      fetch: (url, params) => {
        fetches.push({ url, params });
        const res = fetchImpl(url, params);
        if (res instanceof Error) throw res;
        return {
          getResponseCode: () => res.code,
          getContentText: () => res.body,
          getContent: () => Buffer.from(res.body || "", "utf8"),
        };
      },
    },
    Utilities: {
      base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
      base64Decode: (text) => Buffer.from(text, "base64"),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString("utf8") }),
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(STORAGE_SRC, sandbox, { filename: "Storage.gs" });
  vm.runInContext(CODE_SRC, sandbox, { filename: "Code.gs" });
  return { g: sandbox, store, logRows, fetches };
}

function releases(...tagNames) {
  return JSON.stringify(tagNames.map((tag_name) => ({ tag_name })));
}

describe("pickNewestBuildTags_", () => {
  const { g } = createServer();

  it("sorts by the numeric suffix, not lexically", () => {
    expect(g.pickNewestBuildTags_(releases("build-9", "build-12"))).toEqual(["build-12", "build-9"]);
  });

  it("ignores tag names that are not build-<digits>", () => {
    const json = releases("v1.0.0", "build-3", "build-nightly", "release", "build-07");
    expect(g.pickNewestBuildTags_(json)).toEqual(["build-07", "build-3"]);
  });

  it("returns at most two tags, newest first", () => {
    const tags = g.pickNewestBuildTags_(releases("build-1", "build-5", "build-3", "build-4"));
    expect(tags).toEqual(["build-5", "build-4"]);
  });

  it("handles an empty release list, a non-array, and bad JSON", () => {
    expect(g.pickNewestBuildTags_("[]")).toEqual([]);
    expect(g.pickNewestBuildTags_([])).toEqual([]);
    expect(g.pickNewestBuildTags_(null)).toEqual([]);
    expect(g.pickNewestBuildTags_("not json")).toEqual([]);
  });

  it("accepts an already-parsed array", () => {
    expect(g.pickNewestBuildTags_([{ tag_name: "build-2" }])).toEqual(["build-2"]);
  });
});

describe("buildBaseUrl_", () => {
  const { g } = createServer();

  it("substitutes {tag}", () => {
    expect(g.buildBaseUrl_("https://cdn.jsdelivr.net/gh/rebelribbon/keystone@{tag}", "build-1"))
      .toBe("https://cdn.jsdelivr.net/gh/rebelribbon/keystone@build-1");
  });

  it("strips a trailing slash", () => {
    expect(g.buildBaseUrl_("https://example.com/ks/{tag}/", "build-4")).toBe("https://example.com/ks/build-4");
    expect(g.buildBaseUrl_("https://example.com/ks/{tag}///", "build-4")).toBe("https://example.com/ks/build-4");
  });

  it("falls back to the jsDelivr default when the setting is blank", () => {
    expect(g.buildBaseUrl_("", "build-2")).toBe("https://cdn.jsdelivr.net/gh/rebelribbon/keystone@build-2");
    expect(g.buildBaseUrl_(null, "build-2")).toContain("@build-2");
  });
});

describe("resolveChannel_", () => {
  const { g } = createServer();
  const DEV = "https://script.google.com/macros/s/AKfy/dev";
  const EXEC = "https://script.google.com/macros/s/AKfy/exec";

  it("maps /dev to test and /exec to stable", () => {
    expect(g.resolveChannel_(DEV, "", null)).toBe("test");
    expect(g.resolveChannel_(EXEC, "", null)).toBe("stable");
  });

  it("honors ?channel= for an owner", () => {
    expect(g.resolveChannel_(DEV, "stable", "owner")).toBe("stable");
    expect(g.resolveChannel_(EXEC, "test", "owner")).toBe("test");
  });

  it("ignores ?channel= for editor and viewer", () => {
    expect(g.resolveChannel_(DEV, "stable", "editor")).toBe("test");
    expect(g.resolveChannel_(DEV, "stable", "viewer")).toBe("test");
    expect(g.resolveChannel_(EXEC, "test", "editor")).toBe("stable");
  });

  it("ignores an unrecognized channel value even for an owner", () => {
    expect(g.resolveChannel_(DEV, "banana", "owner")).toBe("test");
  });
});

describe("decideAccess_", () => {
  const { g } = createServer();

  it("denies an empty email", () => {
    const d = g.decideAccess_("", "owner");
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("ACCESS_DENIED");
    expect(d.reason).toBe("no_email");
  });

  it("denies an email with no Users row", () => {
    const d = g.decideAccess_("stranger@example.com", null);
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("ACCESS_DENIED");
    expect(d.reason).toBe("not_listed");
    expect(d.email).toBe("stranger@example.com");
  });

  it("allows a listed email and returns its role", () => {
    const d = g.decideAccess_("owner@example.com", "owner");
    expect(d.allowed).toBe(true);
    expect(d.role).toBe("owner");
    expect(d.code).toBeNull();
  });

  it("is case- and whitespace-insensitive on both email and role", () => {
    const d = g.decideAccess_("  Owner@Example.COM  ", "  Editor ");
    expect(d.allowed).toBe(true);
    expect(d.email).toBe("owner@example.com");
    expect(d.role).toBe("editor");
  });

  it("denies a role that is not one of the three", () => {
    expect(g.decideAccess_("x@example.com", "admin").allowed).toBe(false);
  });
});

describe("parseSettingsRows_", () => {
  const { g } = createServer();

  it("turns rows into a key/value object and skips the header", () => {
    const rows = [SETTINGS_HEADER, ["github_repo", "rebelribbon/keystone"], ["stable_tag", "build-1"]];
    expect(g.parseSettingsRows_(rows)).toEqual({
      github_repo: "rebelribbon/keystone",
      stable_tag: "build-1",
    });
  });

  it("trims values and drops rows with a blank key", () => {
    const rows = [SETTINGS_HEADER, ["  stable_tag  ", "  build-2  "], ["", "orphan"], [null, "x"]];
    expect(g.parseSettingsRows_(rows)).toEqual({ stable_tag: "build-2" });
  });

  it("handles empty input", () => {
    expect(g.parseSettingsRows_([])).toEqual({});
    expect(g.parseSettingsRows_(null)).toEqual({});
  });
});

describe("findRole_", () => {
  const { g } = createServer();
  const rows = [USERS_HEADER, ["Owner@Example.com", "Owner", "2026-01-01"], ["ed@example.com", "editor", ""]];

  it("finds a role regardless of case and whitespace", () => {
    expect(g.findRole_(rows, "  owner@EXAMPLE.com ")).toBe("owner");
    expect(g.findRole_(rows, "ed@example.com")).toBe("editor");
  });

  it("returns null for an unlisted or empty email", () => {
    expect(g.findRole_(rows, "nobody@example.com")).toBeNull();
    expect(g.findRole_(rows, "")).toBeNull();
    expect(g.findRole_(rows, null)).toBeNull();
  });

  it("returns null when the role cell is not a valid role", () => {
    expect(g.findRole_([USERS_HEADER, ["x@example.com", "superuser"]], "x@example.com")).toBeNull();
  });

  it("never matches the header row", () => {
    expect(g.findRole_(rows, "email")).toBeNull();
  });
});

describe("applyTagOverride_", () => {
  const { g } = createServer();
  const base = { tag: "build-9", previousTag: "build-8", degraded: false, degradedReason: "", error: "" };

  it("honors ?tag= for an owner", () => {
    expect(g.applyTagOverride_(base, "build-3", "owner").tag).toBe("build-3");
  });

  it("ignores ?tag= for everyone else", () => {
    expect(g.applyTagOverride_(base, "build-3", "editor").tag).toBe("build-9");
    expect(g.applyTagOverride_(base, "build-3", null).tag).toBe("build-9");
  });

  it("ignores a malformed tag even for an owner", () => {
    expect(g.applyTagOverride_(base, "../etc/passwd", "owner").tag).toBe("build-9");
    expect(g.applyTagOverride_(base, "", "owner").tag).toBe("build-9");
  });
});

describe("resolveRelease_", () => {
  it("test channel serves the newest build tag and keeps the previous one", () => {
    const { g } = createServer({
      fetchImpl: () => ({ code: 200, body: releases("build-7", "build-6", "v1") }),
    });
    const r = g.resolveRelease_("test", { github_repo: "rebelribbon/keystone", stable_tag: "build-1" });
    expect(r.tag).toBe("build-7");
    expect(r.previousTag).toBe("build-6");
    expect(r.degraded).toBe(false);
    expect(r.error).toBe("");
  });

  it("falls back to stable_tag with a degraded flag when the GitHub fetch fails", () => {
    const { g } = createServer({ fetchImpl: () => ({ code: 404, body: "Not Found" }) });
    const r = g.resolveRelease_("test", { github_repo: "rebelribbon/nope", stable_tag: "build-1" });
    expect(r.tag).toBe("build-1");
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toContain("build-*");
    expect(r.error).toBe("");
  });

  it("falls back with a degraded flag when UrlFetchApp throws", () => {
    const { g } = createServer({ fetchImpl: () => new Error("DNS failure") });
    const r = g.resolveRelease_("test", { github_repo: "rebelribbon/keystone", stable_tag: "build-1" });
    expect(r.tag).toBe("build-1");
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toContain("DNS failure");
  });

  it("errors rather than rendering a broken URL when nothing resolves", () => {
    const { g } = createServer({ fetchImpl: () => ({ code: 500, body: "" }) });
    const r = g.resolveRelease_("test", { github_repo: "rebelribbon/keystone" });
    expect(r.tag).toBe("");
    expect(r.error).toContain("stable_tag");
  });

  it("stable channel reads stable_tag, and errors when it is missing", () => {
    const { g } = createServer();
    expect(g.resolveRelease_("stable", { stable_tag: "build-1" }).tag).toBe("build-1");
    expect(g.resolveRelease_("stable", {}).error).toContain("stable_tag");
  });

  it("caches the tag lookup so a second call does not refetch", () => {
    const { g, fetches } = createServer({
      fetchImpl: () => ({ code: 200, body: releases("build-7", "build-6") }),
    });
    const settings = { github_repo: "rebelribbon/keystone", stable_tag: "build-1" };
    g.resolveRelease_("test", settings);
    g.resolveRelease_("test", settings);
    expect(fetches.length).toBe(1);
  });
});

describe("Sheet helpers", () => {
  it("getSettings_ reads the tab once and then serves from cache", () => {
    const { g, store } = createServer({
      settingsRows: [SETTINGS_HEADER, ["stable_tag", "build-1"]],
    });
    expect(g.getSettings_()).toEqual({ stable_tag: "build-1" });
    expect(store.has("ks_settings")).toBe(true);
    expect(g.getSetting_("stable_tag", "")).toBe("build-1");
    expect(g.getSetting_("missing_key", "fallback")).toBe("fallback");
  });

  it("invalidateSettings_ clears the cached object", () => {
    const { g, store } = createServer({ settingsRows: [SETTINGS_HEADER, ["stable_tag", "build-1"]] });
    g.getSettings_();
    g.invalidateSettings_();
    expect(store.has("ks_settings")).toBe(false);
  });

  it("getUserRole_ resolves a listed account and rejects an unlisted one", () => {
    const { g } = createServer({
      usersRows: [USERS_HEADER, ["Owner@Example.com", "owner", ""]],
    });
    expect(g.getUserRole_("owner@example.com")).toBe("owner");
    expect(g.getUserRole_("stranger@example.com")).toBeNull();
  });

  it("logRow_ appends a timestamped row", () => {
    const { g, logRows } = createServer();
    g.logRow_("a@b.com", "access_denied", "", "reason=not_listed");
    expect(logRows).toHaveLength(1);
    expect(Object.prototype.toString.call(logRows[0][0])).toBe("[object Date]");
    expect(logRows[0].slice(1)).toEqual(["a@b.com", "access_denied", "", "reason=not_listed"]);
  });
});

describe("doGet access control", () => {
  const settingsRows = [
    SETTINGS_HEADER,
    ["github_repo", "rebelribbon/keystone"],
    ["stable_tag", "build-1"],
  ];

  it("denies an unlisted account and writes exactly one access_denied Log row", () => {
    const { g, logRows } = createServer({
      email: "stranger@example.com",
      settingsRows,
      usersRows: [USERS_HEADER, ["owner@example.com", "owner", ""]],
    });
    const decision = g.decideAccess_("stranger@example.com", g.getUserRole_("stranger@example.com"));
    expect(decision.allowed).toBe(false);
    g.logRow_(decision.email, "access_denied", "", "reason=" + decision.reason);
    expect(logRows.filter((r) => r[2] === "access_denied")).toHaveLength(1);
  });

  it("api_whoami returns a structured denial for an unlisted account", () => {
    const { g } = createServer({ email: "stranger@example.com", settingsRows });
    expect(g.api_whoami()).toEqual({
      code: "ACCESS_DENIED",
      message: "This Google account is not on the Keystone access list.",
    });
  });

  it("api_whoami returns email and role for a listed account", () => {
    const { g } = createServer({
      email: "Owner@Example.com",
      settingsRows,
      usersRows: [USERS_HEADER, ["owner@example.com", "owner", ""]],
    });
    expect(g.api_whoami()).toEqual({ email: "owner@example.com", role: "owner" });
  });
});

describe("page-safety helpers", () => {
  const { g } = createServer();

  it("escapeHtml_ neutralizes markup", () => {
    expect(g.escapeHtml_('<img src=x onerror="alert(1)">'))
      .toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("toSafeJson_ cannot terminate a script element", () => {
    const json = g.toSafeJson_({ user: "</script><script>alert(1)</script>" });
    expect(json).not.toContain("</script>");
    expect(json).not.toContain("<");
    expect(JSON.parse(json).user).toBe("</script><script>alert(1)</script>");
  });

  it("splitChunks_ splits and rejoins losslessly", () => {
    const text = "abcdefghij";
    expect(g.splitChunks_(text, 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(g.splitChunks_(text, 4).join("")).toBe(text);
    expect(g.splitChunks_("", 4)).toEqual([]);
  });

  it("serviceUrlVariants_ derives both deployment URLs", () => {
    const v = g.serviceUrlVariants_("https://script.google.com/macros/s/AKfy/dev");
    expect(v.test).toBe("https://script.google.com/macros/s/AKfy/dev");
    expect(v.stable).toBe("https://script.google.com/macros/s/AKfy/exec");
    expect(g.serviceUrlVariants_("https://script.google.com/macros/s/AKfy/exec").test)
      .toBe("https://script.google.com/macros/s/AKfy/dev");
  });
});

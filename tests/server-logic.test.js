import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createHash } from "node:crypto";

// The Builder cannot deploy or run Apps Script from a cloud session, so the
// server's decision logic is tested by evaluating the .gs files as text in a
// sandbox with stubbed Apps Script globals (ticket 002, "Constraint").
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STORAGE_SRC = readFileSync(join(root, "src/server/Storage.gs"), "utf8");
const CODE_SRC = readFileSync(join(root, "src/server/Code.gs"), "utf8");
const API_SRC = readFileSync(join(root, "src/server/Api.gs"), "utf8");
const UPDATER_SRC = readFileSync(join(root, "src/server/Updater.gs"), "utf8");

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
    buildsRows = null,
    serviceUrl = "https://script.google.com/macros/s/AKfy/exec",
    fetchImpl = () => ({ code: 404, body: "" }),
    scriptId = "SCRIPT_ID",
  } = options;

  const store = new Map();
  const logRows = [];
  const fetches = [];
  const dialogs = [];
  const drive = { folderId: "FOLDER", files: [], trashed: [], toasts: [] };
  drive.folder = {
    createFile: (name, content, type) => {
      const file = { name, content, type };
      drive.files.push(file);
      return file;
    },
    getFiles: () => iterate(drive.files.filter((f) => !drive.trashed.includes(f.name))),
    getFilesByName: (name) =>
      iterate(
        drive.files
          .filter((f) => f.name === name && !drive.trashed.includes(name))
          .map((f) => ({
            getName: () => f.name,
            setTrashed: () => drive.trashed.push(f.name),
          }))
      ),
  };

  const sheets = {
    Settings: {
      getDataRange: () => ({ getValues: () => settingsRows }),
      appendRow: (row) => settingsRows.push(row),
      getRange: (rowNumber, column) => ({
        setValue: (value) => {
          settingsRows[rowNumber - 1][column - 1] = value;
        },
      }),
    },
    Users: { getDataRange: () => ({ getValues: () => usersRows }) },
    Log: { appendRow: (row) => logRows.push(row) },
  };
  if (buildsRows) {
    sheets.Builds = {
      getDataRange: () => ({ getValues: () => buildsRows }),
      appendRow: (row) => buildsRows.push(row),
      getRange: () => ({ setValues: () => {} }),
    };
  }

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
    ScriptApp: {
      getService: () => ({ getUrl: () => serviceUrl }),
      getScriptId: () => scriptId,
      // The token must never reach a payload, a template, or a Log row. Tests
      // assert on that by searching for this exact string.
      getOAuthToken: () => "SECRET_TOKEN",
    },
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
      DigestAlgorithm: { SHA_256: "SHA_256" },
      // Apps Script returns SIGNED bytes, so the hex conversion has to mask.
      computeDigest: (_algorithm, bytes) => {
        const digest = createHash("sha256").update(Buffer.from(bytes)).digest();
        return Array.from(digest).map((b) => (b > 127 ? b - 256 : b));
      },
      base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
      base64Decode: (text) => Buffer.from(text, "base64"),
      newBlob: (bytes) => ({
        getDataAsString: () => Buffer.from(bytes).toString("utf8"),
        getBytes: () => bytes,
      }),
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
    },
    DriveApp: {
      getFolderById: (id) => {
        if (id !== drive.folderId) throw new Error("unknown folder " + id);
        return drive.folder;
      },
      getFileById: () => {
        throw new Error("no Drive in the sandbox");
      },
    },
  };
  sandbox.SpreadsheetApp.getUi = () => ({
    showModalDialog: (output, title) => dialogs.push({ title, html: output.html }),
    alert: (...args) => dialogs.push({ alert: args }),
    ButtonSet: { OK: "OK" },
    createMenu: () => {
      const menu = {
        items: [],
        addItem(label, fn) {
          menu.items.push({ label, fn });
          return menu;
        },
        addSeparator: () => menu,
        addToUi: () => {},
      };
      sandbox.__menu = menu;
      return menu;
    },
  });
  sandbox.SpreadsheetApp.getActive = () => ({
    getSheetByName: (name) => sheets[name] || null,
    toast: (message) => drive.toasts.push(message),
  });
  sandbox.HtmlService = {
    createHtmlOutput: (html) => {
      const output = { html, setWidth: () => output, setHeight: () => output };
      return output;
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(STORAGE_SRC, sandbox, { filename: "Storage.gs" });
  vm.runInContext(CODE_SRC, sandbox, { filename: "Code.gs" });
  vm.runInContext(API_SRC, sandbox, { filename: "Api.gs" });
  vm.runInContext(UPDATER_SRC, sandbox, { filename: "Updater.gs" });
  return { g: sandbox, store, logRows, fetches, cache, sheets, dialogs, drive };
}

/** Apps Script's FileIterator shape over a plain array. */
function iterate(list) {
  let i = 0;
  return {
    hasNext: () => i < list.length,
    next: () => {
      const item = list[i++];
      return item && item.getName ? item : { getName: () => item.name, setTrashed: () => {} };
    },
  };
}

function sha256(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
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

describe("resolveChannel_ (ADR 0001)", () => {
  const { g } = createServer();

  it("reads the channel from ?c=", () => {
    expect(g.resolveChannel_({ c: "test" })).toBe("test");
    expect(g.resolveChannel_({ c: "stable" })).toBe("stable");
  });

  it("defaults to stable when the parameter is absent or unrecognized", () => {
    expect(g.resolveChannel_({})).toBe("stable");
    expect(g.resolveChannel_(null)).toBe("stable");
    expect(g.resolveChannel_(undefined)).toBe("stable");
    expect(g.resolveChannel_({ c: "banana" })).toBe("stable");
    expect(g.resolveChannel_({ c: "" })).toBe("stable");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(g.resolveChannel_({ c: "  TEST " })).toBe("test");
  });

  it("honors the value regardless of role, since it selects only a public bundle", () => {
    // The signature no longer takes a role at all, which is the point: nothing
    // about ?c= is privileged (ADR 0001 decision 3).
    expect(g.resolveChannel_.length).toBe(1);
    expect(g.resolveChannel_({ c: "test" })).toBe("test");
  });

  it("ignores the service URL entirely, including a /dev one", () => {
    expect(g.resolveChannel_({ c: "stable", serviceUrl: "https://script.google.com/macros/s/AKfy/dev" }))
      .toBe("stable");
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

  it("withChannelParam_ appends ?c=test only for the test channel", () => {
    const base = "https://script.google.com/macros/s/AKfy/exec";
    expect(g.withChannelParam_(base, "test")).toBe(base + "?c=test");
    expect(g.withChannelParam_(base, "stable")).toBe(base);
    expect(g.withChannelParam_(base + "?x=1", "test")).toBe(base + "?x=1&c=test");
    expect(g.withChannelParam_("", "test")).toBe("");
  });
});

const BUILDS_HEADER = [
  "buildId", "name", "owner", "primaryStyle", "levels", "estCostLow", "estCostHigh",
  "created", "updated", "driveFileId", "thumbFileId", "schema", "deleted",
];

describe("rowToBuild_ / buildToRow_", () => {
  const { g } = createServer();

  it("maps a row onto an object by header name", () => {
    const row = ["b_1", "Hill Country", "a@b.com", "style.spanish.texas_hill_country", 2,
                 100, 200, "2026-01-01", "2026-01-02", "file1", "thumb1", 1, ""];
    expect(g.rowToBuild_(BUILDS_HEADER, row)).toMatchObject({
      buildId: "b_1", name: "Hill Country", driveFileId: "file1", schema: 1, deleted: "",
    });
  });

  it("is independent of column order", () => {
    const shuffled = ["deleted", "name", "buildId", "updated"];
    const build = g.rowToBuild_(shuffled, ["true", "Cabin", "b_9", "2026-02-02"]);
    expect(build).toEqual({ deleted: "true", name: "Cabin", buildId: "b_9", updated: "2026-02-02" });
    // And a write lays the values back out in that same order.
    expect(g.buildToRow_(shuffled, build)).toEqual(["true", "Cabin", "b_9", "2026-02-02"]);
  });

  it("round-trips through the sheet's own header order", () => {
    const build = { buildId: "b_2", name: "Ranch", updated: "2026-03-03", deleted: "" };
    const row = g.buildToRow_(BUILDS_HEADER, build);
    expect(row).toHaveLength(BUILDS_HEADER.length);
    expect(g.rowToBuild_(BUILDS_HEADER, row)).toMatchObject(build);
  });

  it("fills missing columns blank rather than shifting the row", () => {
    const row = g.buildToRow_(BUILDS_HEADER, { buildId: "b_3" });
    expect(row).toHaveLength(BUILDS_HEADER.length);
    expect(row[0]).toBe("b_3");
    expect(row.slice(1).every((cell) => cell === "")).toBe(true);
  });

  it("tolerates a row shorter than the header and blank header cells", () => {
    expect(g.rowToBuild_(BUILDS_HEADER, ["b_4", "Short"])).toMatchObject({
      buildId: "b_4", name: "Short", deleted: "",
    });
    expect(g.rowToBuild_(["buildId", "", "name"], ["b_5", "junk", "N"])).toEqual({
      buildId: "b_5", name: "N",
    });
  });

  it("ignores object keys the header does not name", () => {
    expect(g.buildToRow_(["buildId"], { buildId: "b_6", secret: "nope" })).toEqual(["b_6"]);
  });
});

describe("isConflict_", () => {
  const { g } = createServer();
  const earlier = "2026-09-19T10:00:00Z";
  const later = "2026-09-19T11:00:00Z";

  it("is a conflict when the server row is newer than what the client based on", () => {
    expect(g.isConflict_(earlier, later)).toBe(true);
  });

  it("is not a conflict when the client is current or ahead", () => {
    expect(g.isConflict_(later, earlier)).toBe(false);
    expect(g.isConflict_(later, later)).toBe(false);
  });

  it("treats equal timestamps as no conflict", () => {
    expect(g.isConflict_(earlier, earlier)).toBe(false);
  });

  it("refuses to clobber when the client sends no baseUpdated", () => {
    expect(g.isConflict_(undefined, later)).toBe(true);
    expect(g.isConflict_("", later)).toBe(true);
    expect(g.isConflict_(null, later)).toBe(true);
  });

  it("is not a conflict when the server row has no timestamp to compare", () => {
    expect(g.isConflict_(earlier, "")).toBe(false);
    expect(g.isConflict_(undefined, undefined)).toBe(false);
  });

  it("accepts Date objects on either side", () => {
    expect(g.isConflict_(new Date(earlier), new Date(later))).toBe(true);
    expect(g.isConflict_(new Date(later), new Date(earlier))).toBe(false);
  });
});

describe("listBuildRows_", () => {
  it("returns non-deleted builds newest first", () => {
    const { g } = createServer({
      buildsRows: [
        BUILDS_HEADER,
        ["b_old", "Old", "a@b.com", "", 1, "", "", "", "2026-01-01T00:00:00Z", "f1", "", 1, ""],
        ["b_gone", "Gone", "a@b.com", "", 1, "", "", "", "2026-05-01T00:00:00Z", "f2", "", 1, "true"],
        ["b_new", "New", "a@b.com", "", 1, "", "", "", "2026-03-01T00:00:00Z", "f3", "", 1, ""],
      ],
    });
    const builds = g.listBuildRows_();
    expect(builds.map((b) => b.buildId)).toEqual(["b_new", "b_old"]);
  });
});

describe("every api_* function is behind the Users gate", () => {
  // Acceptance: an account with no Users row gets denied on every api_* call,
  // not just on doGet.
  const CALLS = [
    ["api_whoami", []],
    ["api_listBuilds", []],
    ["api_beginSave", [null, {}]],
    ["api_saveChunk", ["u_1", 0, "AAAA"]],
    ["api_commitSave", ["u_1", 1, null]],
    ["api_loadBuildInfo", ["b_1"]],
    ["api_loadChunk", ["b_1", 0]],
    ["api_deleteBuild", ["b_1"]],
    ["api_getSettings", []],
    ["api_setSetting", ["stable_tag", "build-9"]],
    ["api_getBundle", ["build-5", "engine.js"]],
  ];

  it.each(CALLS)("%s denies an unlisted account", (name, args) => {
    const { g } = createServer({
      email: "stranger@example.com",
      usersRows: [USERS_HEADER, ["owner@example.com", "owner", ""]],
    });
    expect(typeof g[name], `${name} must exist`).toBe("function");
    expect(g[name].apply(null, args)).toMatchObject({ code: "ACCESS_DENIED" });
  });

  it.each(CALLS)("%s denies a request with no resolvable account", (name, args) => {
    const { g } = createServer({ email: "" });
    expect(g[name].apply(null, args)).toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("exposes no api_ function whose name Apps Script would hide from the client", () => {
    // A trailing underscore makes a function uncallable by google.script.run —
    // the defect that left loader_mode: inline unreachable in ticket 002.
    const hidden = Object.keys(createServer().g).filter((k) => /^api_.*_$/.test(k));
    expect(hidden).toEqual([]);
  });
});

describe("api_saveChunk chunk cap", () => {
  const OWNER = { email: "owner@example.com", usersRows: [USERS_HEADER, ["owner@example.com", "owner", ""]] };

  it("rejects an oversized chunk with CHUNK_TOO_LARGE so the client can halve", () => {
    const { g } = createServer(OWNER);
    const begun = g.api_beginSave(null, { name: "x" });
    const oversized = "A".repeat(100001);
    expect(g.api_saveChunk(begun.uploadId, 0, oversized)).toMatchObject({ code: "CHUNK_TOO_LARGE" });
  });

  it("accepts a chunk exactly at the floor size", () => {
    const { g } = createServer(OWNER);
    const begun = g.api_beginSave(null, { name: "x" });
    expect(g.api_saveChunk(begun.uploadId, 0, "A".repeat(100000))).toEqual({ ok: true });
  });

  it("rejects a chunk for an unknown or expired upload", () => {
    const { g } = createServer(OWNER);
    expect(g.api_saveChunk("u_nope", 0, "AAAA")).toMatchObject({ code: "UPLOAD_EXPIRED" });
  });

  it("api_getBundle refuses arguments that could steer the fetch", () => {
    const { g } = createServer(OWNER);
    expect(g.api_getBundle("../../etc", "engine.js")).toMatchObject({ code: "BAD_REQUEST" });
    expect(g.api_getBundle("build-5", "../../../secrets")).toMatchObject({ code: "BAD_REQUEST" });
    expect(g.api_getBundle("build-5", "styles.css")).toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("load path chunk cache (ticket 005)", () => {
  const OWNER = {
    email: "owner@example.com",
    usersRows: [USERS_HEADER, ["owner@example.com", "owner", ""]],
  };
  const UPDATED = "2026-09-19T16:54:39.000Z";
  const BUILD_ID = "b_cache01";

  /** A build whose file is big enough to span several 100,000-char chunks. */
  function withBuild(extra) {
    return {
      ...OWNER,
      ...extra,
      buildsRows: [
        BUILDS_HEADER,
        [BUILD_ID, "Cached", "owner@example.com", "", 1, "", "", UPDATED, UPDATED, "file_1", "", 1, ""],
      ],
    };
  }

  /** Deterministic 187,500-byte payload -> 250,000 base64 chars -> 3 chunks. */
  function payload() {
    const bytes = Buffer.alloc(187500);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    return bytes;
  }

  /** Swap readBuildFile_ for a counting stub and return the call counter. */
  function stubDriveRead(g, bytes) {
    const calls = { count: 0 };
    g.readBuildFile_ = () => {
      calls.count++;
      return bytes;
    };
    return calls;
  }

  it("a cache hit returns the cached chunk and never touches Drive", () => {
    const { g } = createServer(withBuild());
    const bytes = payload();
    const reads = stubDriveRead(g, bytes);

    const info = g.api_loadBuildInfo(BUILD_ID);
    expect(info.totalChunks).toBe(3);
    expect(info.cacheKeyBase).toBe(`ks_dl_${BUILD_ID}_${Date.parse(UPDATED)}`);
    expect(reads.count).toBe(1); // the one encode api_loadBuildInfo already paid for

    const result = g.api_loadChunk(BUILD_ID, 1, info.cacheKeyBase);
    expect(result.cached).toBe(true);
    expect(reads.count).toBe(1); // unchanged: the hit did no Drive read at all
  });

  it("a miss returns the same bytes as a hit, and re-populates the key", () => {
    const { g, cache } = createServer(withBuild());
    const bytes = payload();
    stubDriveRead(g, bytes);

    const info = g.api_loadBuildInfo(BUILD_ID);
    const key = `${info.cacheKeyBase}_2`;

    // What the warm path returns for chunk 2.
    const hit = g.api_loadChunk(BUILD_ID, 2, info.cacheKeyBase);
    expect(hit.cached).toBe(true);

    // Evict exactly that key and ask again.
    cache.remove(key);
    const miss = g.api_loadChunk(BUILD_ID, 2, info.cacheKeyBase);

    expect(miss.cached).toBe(false);
    // The property the whole design rests on: the two paths agree byte for byte.
    expect(miss.chunk).toBe(hit.chunk);
    expect(miss.chunk).toBe(
      Buffer.from(bytes).toString("base64").substr(2 * 100000, 100000)
    );
    // And the miss put the key back.
    expect(cache.get(key)).toBe(hit.chunk);
    expect(g.api_loadChunk(BUILD_ID, 2, info.cacheKeyBase).cached).toBe(true);
  });

  it("a null cacheKeyBase always takes the slow path", () => {
    const { g } = createServer(withBuild());
    const bytes = payload();
    const reads = stubDriveRead(g, bytes);

    const info = g.api_loadBuildInfo(BUILD_ID);
    const before = reads.count;

    const cold = g.api_loadChunk(BUILD_ID, 0, null);
    expect(cold.cached).toBe(false);
    expect(reads.count).toBe(before + 1);
    expect(cold.chunk).toBe(Buffer.from(bytes).toString("base64").substr(0, 100000));

    // Undefined and empty string behave the same way.
    expect(g.api_loadChunk(BUILD_ID, 0).cached).toBe(false);
    expect(g.api_loadChunk(BUILD_ID, 0, "").cached).toBe(false);
  });

  it("a cache get that throws is a miss, not an error", () => {
    const { g, cache } = createServer(withBuild());
    const bytes = payload();
    stubDriveRead(g, bytes);
    const info = g.api_loadBuildInfo(BUILD_ID);

    // Throw only for download keys. A blanket throw would also break the Users
    // lookup in the auth path and the call would come back ACCESS_DENIED,
    // which tests something else entirely (see the Handoff).
    const realGet = cache.get.bind(cache);
    cache.get = (key) => {
      if (String(key).indexOf("ks_dl_") === 0) throw new Error("cache backend unavailable");
      return realGet(key);
    };

    const result = g.api_loadChunk(BUILD_ID, 1, info.cacheKeyBase);
    expect(result.code).toBeUndefined();
    expect(result.cached).toBe(false);
    expect(result.chunk).toBe(Buffer.from(bytes).toString("base64").substr(100000, 100000));
  });

  it("a cold cache produces the same whole payload as a warm one", () => {
    const bytes = payload();
    const join = (g, base) => {
      const out = [];
      for (let i = 0; i < 3; i++) out.push(g.api_loadChunk(BUILD_ID, i, base).chunk);
      return out.join("");
    };

    const warm = createServer(withBuild());
    stubDriveRead(warm.g, bytes);
    const warmInfo = warm.g.api_loadBuildInfo(BUILD_ID);

    const cold = createServer(withBuild());
    stubDriveRead(cold.g, bytes);
    cold.g.api_loadBuildInfo(BUILD_ID);

    expect(join(warm.g, warmInfo.cacheKeyBase)).toBe(join(cold.g, null));
    expect(join(cold.g, null)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("a re-saved build never serves chunks from the previous revision", () => {
    const later = "2026-09-19T18:00:00.000Z";
    const { g } = createServer(withBuild());
    stubDriveRead(g, payload());

    const first = g.api_loadBuildInfo(BUILD_ID);
    expect(first.cacheKeyBase).toContain(String(Date.parse(UPDATED)));

    // Simulate a re-save: the row's `updated` moves on.
    const table = g.readBuildsSheet_();
    table.rows[0][BUILDS_HEADER.indexOf("updated")] = later;

    const second = g.api_loadBuildInfo(BUILD_ID);
    expect(second.cacheKeyBase).toBe(`ks_dl_${BUILD_ID}_${Date.parse(later)}`);
    expect(second.cacheKeyBase).not.toBe(first.cacheKeyBase);
  });

  it("rejects a cacheKeyBase that points outside this build's key space", () => {
    const { g } = createServer(withBuild());
    expect(g.isDownloadKeyBase_(`ks_dl_${BUILD_ID}_123`, BUILD_ID)).toBe(true);
    // A crafted base must not be able to read another key space.
    expect(g.isDownloadKeyBase_("ks_upload_someoneelse", BUILD_ID)).toBe(false);
    expect(g.isDownloadKeyBase_("ks_settings", BUILD_ID)).toBe(false);
    expect(g.isDownloadKeyBase_("ks_dl_b_other_123", BUILD_ID)).toBe(false);
    expect(g.isDownloadKeyBase_(`ks_dl_${BUILD_ID}_12_3`, BUILD_ID)).toBe(false);
    expect(g.isDownloadKeyBase_(null, BUILD_ID)).toBe(false);
  });

  it("api_devEvictChunk is owner-only, validated, and client-callable", () => {
    const { g, cache } = createServer(withBuild());
    stubDriveRead(g, payload());
    const info = g.api_loadBuildInfo(BUILD_ID);

    expect(g.api_devEvictChunk(info.cacheKeyBase, 1)).toEqual({ ok: true, evicted: 1 });
    expect(cache.get(`${info.cacheKeyBase}_1`)).toBeNull();
    expect(g.api_devEvictChunk("not-a-key-base", 1)).toMatchObject({ code: "BAD_REQUEST" });

    const editor = createServer({
      ...withBuild(),
      email: "ed@example.com",
      usersRows: [USERS_HEADER, ["ed@example.com", "editor", ""]],
    });
    expect(editor.g.api_devEvictChunk("ks_dl_b_x_1", 1)).toMatchObject({ code: "FORBIDDEN" });
  });
});

/* ---------------------------------------------------------------------------
 * Ticket 004 — the updater (SPEC §2.1 gate 6, ADR 0002)
 * ------------------------------------------------------------------------ */

const OWNER = "owner@example.com";
const TAG = "build-9";
const CDN = "https://cdn.example/keystone@{tag}";
const BASE = "https://cdn.example/keystone@build-9";

/** The six server files a release carries, as source text. */
function serverSources(overrides = {}) {
  return {
    "dist/server/appsscript.json": '{"runtimeVersion":"V8"}',
    "dist/server/Code.gs": "function doGet(){}",
    "dist/server/Storage.gs": "function getSettings_(){}",
    "dist/server/Api.gs": "function api_whoami(){}",
    "dist/server/Updater.gs": "function ksUpdaterListTags(){}",
    "dist/server/Index.html": "<html></html>",
    ...overrides,
  };
}

/**
 * A release manifest over those sources, plus the fetchImpl that serves them
 * and answers the Apps Script API. `corrupt` swaps a file's bytes after the
 * manifest digest is computed, which is exactly the tampered-push case.
 */
function updaterFixture(options = {}) {
  const {
    sources = serverSources(),
    serverList = Object.keys(serverSources()),
    corrupt = null,
    existingFiles = [
      { name: "appsscript", type: "JSON", source: "{}" },
      { name: "Code", type: "SERVER_JS", source: "// old" },
      { name: "Scratch", type: "SERVER_JS", source: "// hand-written, not in any release" },
    ],
    digestOverrides = {},
    versionNumber = 12,
    testVersion = 11,
    stableVersion = 7,
    apiFailures = {},
  } = options;

  const manifest = {
    tag: TAG,
    commit: "abc",
    schemaVersion: 1,
    files: Object.keys(sources).map((path) => ({
      path,
      bytes: sources[path].length,
      sha256: digestOverrides[path] || sha256(sources[path]),
    })),
    server: serverList,
  };

  const served = { ...sources };
  if (corrupt) served[corrupt] = sources[corrupt] + " /* tampered after release */";

  const api = { put: [], post: [], get: [] };

  const fetchImpl = (url, params) => {
    const method = String((params && params.method) || "get").toLowerCase();
    if (url === `${BASE}/dist/manifest.json`) {
      return { code: 200, body: JSON.stringify(manifest) };
    }
    if (url.startsWith(`${BASE}/`)) {
      const path = url.slice(BASE.length + 1);
      if (served[path] === undefined) return { code: 404, body: "not found" };
      return { code: 200, body: served[path] };
    }
    if (url.includes("api.github.com")) {
      return { code: 200, body: releases("build-9", "build-8", "build-7") };
    }
    if (url.includes("script.googleapis.com")) {
      const tail = url.split("/projects/SCRIPT_ID")[1];
      if (apiFailures[method + " " + tail]) return apiFailures[method + " " + tail];
      if (method === "get" && tail === "/content") {
        api.get.push(tail);
        return { code: 200, body: JSON.stringify({ scriptId: "SCRIPT_ID", files: existingFiles }) };
      }
      if (method === "put" && tail === "/content") {
        api.put.push({ tail, body: JSON.parse(params.payload) });
        return { code: 200, body: JSON.stringify({ scriptId: "SCRIPT_ID" }) };
      }
      if (method === "post" && tail === "/versions") {
        api.post.push({ tail, body: JSON.parse(params.payload) });
        return { code: 200, body: JSON.stringify({ versionNumber }) };
      }
      if (method === "get" && tail.startsWith("/deployments/")) {
        const isTest = tail.endsWith("TEST_DEP");
        return {
          code: 200,
          body: JSON.stringify({
            deploymentConfig: { versionNumber: isTest ? testVersion : stableVersion },
          }),
        };
      }
      if (method === "put" && tail.startsWith("/deployments/")) {
        api.put.push({ tail, body: JSON.parse(params.payload) });
        return { code: 200, body: JSON.stringify({ deploymentId: tail.split("/").pop() }) };
      }
    }
    return { code: 404, body: "" };
  };

  return { manifest, sources, served, api, fetchImpl };
}

function updaterServer(fixture, overrides = {}) {
  const settingsRows = overrides.settingsRows || [
    SETTINGS_HEADER,
    ["builds_folder_id", "FOLDER"],
    ["github_repo", "rebelribbon/keystone"],
    ["asset_base_url", CDN],
    ["stable_tag", "build-8"],
    ["test_url", "https://script.example/test/exec"],
    ["stable_url", "https://script.example/stable/exec"],
    ["testDeploymentId", "TEST_DEP"],
    ["stableDeploymentId", "STABLE_DEP"],
  ];
  return createServer({
    email: OWNER,
    usersRows: [USERS_HEADER, [OWNER, "owner", ""]],
    settingsRows,
    fetchImpl: fixture.fetchImpl,
    ...overrides,
    settingsRows,
  });
}

describe("updaterEntryForPath_ / mapServerEntries_", () => {
  const { g } = createServer();

  it("derives name and type from the extension", () => {
    expect(g.updaterEntryForPath_("dist/server/Code.gs")).toEqual({
      path: "dist/server/Code.gs",
      name: "Code",
      type: "SERVER_JS",
    });
    expect(g.updaterEntryForPath_("dist/server/Index.html")).toMatchObject({ name: "Index", type: "HTML" });
    expect(g.updaterEntryForPath_("dist/server/appsscript.json")).toMatchObject({
      name: "appsscript",
      type: "JSON",
    });
  });

  it("aborts on an extension it cannot classify", () => {
    expect(() => g.updaterEntryForPath_("dist/server/notes.txt")).toThrow(/cannot classify/);
    expect(() => g.updaterEntryForPath_("dist/server/README")).toThrow(/cannot classify/);
    try {
      g.updaterEntryForPath_("dist/server/notes.txt");
    } catch (err) {
      expect(err.ksCode).toBe("UPDATER_UNKNOWN_FILE");
    }
  });

  it("aborts on an empty server list rather than writing an empty project", () => {
    expect(() => g.mapServerEntries_([])).toThrow(/nothing to write/);
    expect(() => g.mapServerEntries_(null)).toThrow(/nothing to write/);
    try {
      g.mapServerEntries_([]);
    } catch (err) {
      expect(err.ksCode).toBe("UPDATER_NO_SERVER_FILES");
    }
  });

  it("maps a whole release list", () => {
    const names = g.mapServerEntries_(Object.keys(serverSources())).map((e) => e.name);
    expect(names).toEqual(["appsscript", "Code", "Storage", "Api", "Updater", "Index"]);
  });
});

describe("mergeProjectFiles_", () => {
  const { g } = createServer();

  it("replaces matching entries and preserves unlisted ones", () => {
    const merged = g.mergeProjectFiles_(
      [
        { name: "appsscript", type: "JSON", source: "{}" },
        { name: "Code", type: "SERVER_JS", source: "// old" },
        { name: "Scratch", type: "SERVER_JS", source: "// keep me" },
      ],
      [
        { name: "appsscript", type: "JSON", source: '{"new":true}' },
        { name: "Code", type: "SERVER_JS", source: "// new" },
        { name: "Updater", type: "SERVER_JS", source: "// added" },
      ]
    );
    expect(merged.map((f) => f.name)).toEqual(["appsscript", "Code", "Scratch", "Updater"]);
    expect(merged.find((f) => f.name === "Scratch").source).toBe("// keep me");
    expect(merged.find((f) => f.name === "Code").source).toBe("// new");
  });

  it("refuses a payload that would drop appsscript", () => {
    expect(() =>
      g.mergeProjectFiles_(
        [{ name: "Code", type: "SERVER_JS", source: "// old" }],
        [{ name: "Code", type: "SERVER_JS", source: "// new" }]
      )
    ).toThrow(/would not contain "appsscript"/);
    try {
      g.mergeProjectFiles_([], []);
    } catch (err) {
      expect(err.ksCode).toBe("UPDATER_MANIFEST_MISSING");
    }
  });
});

describe("updater pure helpers", () => {
  const { g } = createServer();

  it("converts signed digest bytes to hex", () => {
    expect(g.bytesToHex_([0, 15, 16, -1, 127, -128])).toBe("000f10ff7f80");
    expect(g.bytesToHex_([])).toBe("");
    expect(g.bytesToHex_(null)).toBe("");
  });

  it("digests the manifest into a path → sha map", () => {
    const digests = g.manifestDigests_({
      files: [{ path: "dist/server/Code.gs", sha256: "AABB" }, { path: "", sha256: "x" }],
    });
    expect(digests).toEqual({ "dist/server/Code.gs": "aabb" });
  });

  it("fingerprints in a stable order regardless of input order", () => {
    const digests = { "dist/server/Code.gs": "a".repeat(64), "dist/server/Api.gs": "b".repeat(64) };
    const forward = g.fingerprintDigests_(
      [{ path: "dist/server/Code.gs" }, { path: "dist/server/Api.gs" }],
      digests
    );
    const reverse = g.fingerprintDigests_(
      [{ path: "dist/server/Api.gs" }, { path: "dist/server/Code.gs" }],
      digests
    );
    expect(forward).toBe(reverse);
    expect(forward).toBe("Api.gs:bbbbbbbbbbbb Code.gs:aaaaaaaaaaaa");
  });

  it("names backups so they sort by timestamp and prunes to the ten newest", () => {
    const name = g.backupFileName_(new Date("2026-09-19T22:43:08.123Z"));
    expect(name).toBe("server-backup-2026-09-19T22-43-08-123Z.json");

    const names = [];
    for (let i = 1; i <= 13; i += 1) {
      names.push(`server-backup-2026-09-${String(i).padStart(2, "0")}T00-00-00-000Z.json`);
    }
    names.push("b_something.ksb");
    const stale = g.staleBackupNames_(names, 10);
    expect(stale).toHaveLength(3);
    expect(stale).toContain("server-backup-2026-09-01T00-00-00-000Z.json");
    expect(stale).toContain("server-backup-2026-09-03T00-00-00-000Z.json");
    expect(stale).not.toContain("server-backup-2026-09-04T00-00-00-000Z.json");
    expect(stale).not.toContain("b_something.ksb");
  });

  it("reads release dates without re-implementing tag selection", () => {
    const body = JSON.stringify([
      { tag_name: "build-9", published_at: "2026-09-19T22:00:00Z" },
      { tag_name: "v0.0.0", published_at: "2026-09-01T00:00:00Z" },
    ]);
    expect(g.releaseDatesByTag_(body)["build-9"]).toBe("2026-09-19T22:00:00Z");
    expect(g.releaseDatesByTag_("not json")).toEqual({});
  });

  it("names the likely fix for the Apps Script API status codes that bite", () => {
    expect(g.updaterApiHint_(403)).toMatch(/usersettings/);
    expect(g.updaterApiHint_(401)).toMatch(/script\.deployments/);
    expect(g.updaterApiHint_(404)).toMatch(/testDeploymentId/);
    expect(g.updaterApiHint_(500)).toBe("");
  });

  it("pickNewestBuildTags_ still defaults to two and takes a limit", () => {
    const body = releases("build-7", "build-8", "build-9", "build-10");
    expect(g.pickNewestBuildTags_(body)).toEqual(["build-10", "build-9"]);
    expect(g.pickNewestBuildTags_(body, 10)).toEqual(["build-10", "build-9", "build-8", "build-7"]);
    expect(g.pickNewestBuildTags_(body, 0)).toEqual(["build-10", "build-9"]);
  });
});

describe("performServerUpdate_ end to end", () => {
  it("verifies, backs up, writes, versions, and repoints test", () => {
    const fixture = updaterFixture();
    const { g, logRows, drive } = updaterServer(fixture);

    const result = g.ksUpdaterApplyTag(TAG);
    expect(result.code).toBeUndefined();
    expect(result).toMatchObject({ ok: true, tag: TAG, version: 12, fileCount: 6, testRepointed: true });
    expect(result.notes).toEqual([]);

    // The backup is written before the PUT, and holds the OLD content.
    expect(drive.files).toHaveLength(1);
    expect(drive.files[0].name).toMatch(/^server-backup-.*\.json$/);
    expect(JSON.parse(drive.files[0].content).files.map((f) => f.name)).toEqual([
      "appsscript",
      "Code",
      "Scratch",
    ]);

    const contentPut = fixture.api.put.find((call) => call.tail === "/content");
    expect(contentPut.body.files.map((f) => f.name)).toEqual([
      "appsscript",
      "Code",
      "Scratch",
      "Storage",
      "Api",
      "Updater",
      "Index",
    ]);
    expect(contentPut.body.files.find((f) => f.name === "Scratch").source).toMatch(/hand-written/);
    expect(contentPut.body.files.find((f) => f.name === "Index").type).toBe("HTML");

    expect(fixture.api.post[0].body.description).toBe("build-9 via updater");
    const repoint = fixture.api.put.find((call) => call.tail === "/deployments/TEST_DEP");
    expect(repoint.body.deploymentConfig).toMatchObject({ versionNumber: 12, manifestFileName: "appsscript" });
    expect(fixture.api.put.some((call) => call.tail === "/deployments/STABLE_DEP")).toBe(false);

    const logged = logRows.find((row) => row[2] === "server_update");
    expect(logged[3 + 1]).toMatch(/build-9 version=12 test=repointed files=6/);
  });

  it("records the tag and fingerprint in Settings", () => {
    const fixture = updaterFixture();
    const { g } = updaterServer(fixture);
    const result = g.ksUpdaterApplyTag(TAG);

    const settings = g.getSettings_();
    expect(settings.server_tag).toBe(TAG);
    expect(settings.server_fingerprint).toBe(result.fingerprint);
    expect(result.fingerprint).toMatch(/Code\.gs:[0-9a-f]{12}/);
  });

  it("never lets the OAuth token into a result, a log row, or a backup", () => {
    const fixture = updaterFixture();
    const { g, logRows, drive } = updaterServer(fixture);
    const result = g.ksUpdaterApplyTag(TAG);

    const surfaces = JSON.stringify(result) + JSON.stringify(logRows) + JSON.stringify(drive.files);
    expect(surfaces).not.toContain("SECRET_TOKEN");
    // It does reach the Authorization header, which is the only place it belongs.
    expect(JSON.stringify(fixture.api)).not.toContain("SECRET_TOKEN");
  });

  it("aborts on a digest mismatch before anything is written", () => {
    const fixture = updaterFixture({ corrupt: "dist/server/Code.gs" });
    const { g, drive } = updaterServer(fixture);

    const result = g.ksUpdaterApplyTag(TAG);
    expect(result).toMatchObject({ code: "UPDATER_DIGEST_MISMATCH" });
    expect(result.message).toMatch(/Nothing was written/);
    expect(fixture.api.put).toHaveLength(0);
    expect(fixture.api.post).toHaveLength(0);
    expect(fixture.api.get).toHaveLength(0);
    expect(drive.files).toHaveLength(0);
  });

  it("aborts when the manifest records no digest for a listed server file", () => {
    const fixture = updaterFixture({
      digestOverrides: {},
      serverList: [...Object.keys(serverSources()), "dist/server/Ghost.gs"],
    });
    const { g } = updaterServer(fixture);
    expect(g.ksUpdaterApplyTag(TAG)).toMatchObject({ code: "UPDATER_DIGEST_MISSING" });
    expect(fixture.api.put).toHaveLength(0);
  });

  it("aborts on an empty server array with nothing written", () => {
    const fixture = updaterFixture({ serverList: [] });
    const { g, drive } = updaterServer(fixture);
    expect(g.ksUpdaterApplyTag(TAG)).toMatchObject({ code: "UPDATER_NO_SERVER_FILES" });
    expect(fixture.api.put).toHaveLength(0);
    expect(drive.files).toHaveLength(0);
  });

  it("aborts on a server file with an unknown extension", () => {
    const fixture = updaterFixture({
      sources: serverSources({ "dist/server/notes.txt": "hello" }),
      serverList: [...Object.keys(serverSources()), "dist/server/notes.txt"],
    });
    const { g } = updaterServer(fixture);
    expect(g.ksUpdaterApplyTag(TAG)).toMatchObject({ code: "UPDATER_UNKNOWN_FILE" });
    expect(fixture.api.put).toHaveLength(0);
  });

  it("rejects a tag that is not build-N", () => {
    const fixture = updaterFixture();
    const { g } = updaterServer(fixture);
    expect(g.ksUpdaterApplyTag("main")).toMatchObject({ code: "BAD_REQUEST" });
    expect(g.ksUpdaterApplyTag("")).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("still writes and versions when testDeploymentId is empty, and names the key", () => {
    const fixture = updaterFixture();
    const { g } = updaterServer(fixture, {
      settingsRows: [
        SETTINGS_HEADER,
        ["builds_folder_id", "FOLDER"],
        ["asset_base_url", CDN],
        ["github_repo", "rebelribbon/keystone"],
      ],
    });

    const result = g.ksUpdaterApplyTag(TAG);
    expect(result).toMatchObject({ ok: true, version: 12, testRepointed: false });
    expect(fixture.api.put.some((call) => call.tail === "/content")).toBe(true);
    expect(fixture.api.post).toHaveLength(1);
    expect(fixture.api.put.some((call) => call.tail.startsWith("/deployments/"))).toBe(false);
    expect(result.notes.join(" ")).toContain("testDeploymentId");
    expect(result.notes.join(" ")).toContain("stableDeploymentId");
  });

  it("surfaces the Apps Script API hint when the API is switched off", () => {
    const fixture = updaterFixture({
      apiFailures: { "get /content": { code: 403, body: '{"error":{"message":"API disabled"}}' } },
    });
    const { g, drive } = updaterServer(fixture);
    const result = g.ksUpdaterApplyTag(TAG);
    expect(result).toMatchObject({ code: "UPDATER_API_FAILED" });
    expect(result.message).toMatch(/usersettings/);
    expect(drive.files).toHaveLength(0);
  });

  it("prunes backups to the ten newest", () => {
    const fixture = updaterFixture();
    const { g, drive } = updaterServer(fixture);
    for (let i = 1; i <= 12; i += 1) {
      drive.files.push({
        name: `server-backup-2026-09-${String(i).padStart(2, "0")}T00-00-00-000Z.json`,
        content: "{}",
      });
    }
    g.ksUpdaterApplyTag(TAG);
    // 12 pre-existing + 1 new = 13; the three oldest go.
    expect(drive.trashed).toHaveLength(3);
    expect(drive.trashed).toContain("server-backup-2026-09-01T00-00-00-000Z.json");
    expect(drive.trashed).toContain("server-backup-2026-09-03T00-00-00-000Z.json");
  });
});

describe("promote to stable", () => {
  it("reports what each deployment serves", () => {
    const fixture = updaterFixture();
    const { g } = updaterServer(fixture);
    expect(g.ksUpdaterDeploymentState()).toMatchObject({
      testVersion: 11,
      stableVersion: 7,
      testConfigured: true,
      stableConfigured: true,
      missingKeys: [],
    });
  });

  it("repoints stable at the version already on test and creates nothing", () => {
    const fixture = updaterFixture();
    const { g, logRows } = updaterServer(fixture);
    const result = g.ksUpdaterPromote(11);

    expect(result).toMatchObject({ ok: true, version: 11, previousVersion: 7 });
    expect(fixture.api.post).toHaveLength(0);
    const repoint = fixture.api.put.find((call) => call.tail === "/deployments/STABLE_DEP");
    expect(repoint.body.deploymentConfig.versionNumber).toBe(11);
    expect(logRows.some((row) => row[2] === "server_promote")).toBe(true);
  });

  it("refuses when the version moved since the dialog read it", () => {
    const fixture = updaterFixture({ testVersion: 14 });
    const { g } = updaterServer(fixture);
    const result = g.ksUpdaterPromote(11);
    expect(result).toMatchObject({ code: "UPDATER_VERSION_MOVED" });
    expect(result.message).toMatch(/Nothing was promoted/);
    expect(fixture.api.put.some((call) => call.tail.startsWith("/deployments/"))).toBe(false);
  });

  it("names the missing Settings key rather than half-promoting", () => {
    const fixture = updaterFixture();
    const { g } = updaterServer(fixture, {
      settingsRows: [SETTINGS_HEADER, ["testDeploymentId", "TEST_DEP"]],
    });
    expect(g.ksUpdaterPromote(11)).toMatchObject({ code: "SETTING_MISSING" });
    expect(g.ksUpdaterDeploymentState().missingKeys).toEqual(["stableDeploymentId"]);
  });
});

describe("the updater is owner-only at every entry point", () => {
  const ENTRY_POINTS = [
    ["ksUpdaterListTags", []],
    ["ksUpdaterApplyTag", [TAG]],
    ["ksUpdaterDeploymentState", []],
    ["ksUpdaterPromote", [11]],
  ];

  it("refuses an editor with FORBIDDEN and writes nothing", () => {
    const fixture = updaterFixture();
    const { g, drive } = updaterServer(fixture, {
      email: "ed@example.com",
      usersRows: [USERS_HEADER, ["ed@example.com", "editor", ""]],
    });
    for (const [name, args] of ENTRY_POINTS) {
      expect(g[name](...args), name).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(fixture.api.put).toHaveLength(0);
    expect(fixture.api.post).toHaveLength(0);
    expect(drive.files).toHaveLength(0);
  });

  it("refuses an unlisted account with ACCESS_DENIED", () => {
    const fixture = updaterFixture();
    const { g } = updaterServer(fixture, { email: "nobody@example.com", usersRows: [USERS_HEADER] });
    for (const [name, args] of ENTRY_POINTS) {
      expect(g[name](...args), name).toMatchObject({ code: "ACCESS_DENIED" });
    }
    expect(fixture.api.put).toHaveLength(0);
  });

  it("toasts one line for a non-owner menu selection and opens no dialog", () => {
    const fixture = updaterFixture();
    const { g, dialogs, drive } = updaterServer(fixture, {
      email: "ed@example.com",
      usersRows: [USERS_HEADER, ["ed@example.com", "editor", ""]],
    });
    g.ksMenuUpdateServerCode();
    g.ksMenuPromoteServerToStable();
    expect(dialogs).toHaveLength(0);
    expect(drive.toasts).toEqual(["Keystone: owner only.", "Keystone: owner only."]);
  });
});

describe("the updater menu and dialogs", () => {
  it("adds both items to the Keystone menu", () => {
    const fixture = updaterFixture();
    const { g } = updaterServer(fixture);
    g.onOpen();
    expect(g.__menu.items.map((i) => i.label)).toEqual([
      "Open test URL",
      "Open stable URL",
      "Update server code…",
      "Promote server code to stable…",
    ]);
    // Every menu target must exist, or the item throws when clicked.
    for (const item of g.__menu.items) expect(typeof g[item.fn]).toBe("function");
  });

  it("opens dialogs whose inline script actually parses", () => {
    const fixture = updaterFixture();
    const { g, dialogs } = updaterServer(fixture);
    g.ksMenuUpdateServerCode();
    g.ksMenuPromoteServerToStable();
    expect(dialogs).toHaveLength(2);

    for (const dialog of dialogs) {
      const script = dialog.html.split("<script>")[1].split("</script>")[0];
      // The dialog markup is assembled as a string in a .gs file, so a quoting
      // slip is invisible until the owner clicks the menu item. Parse it here.
      expect(() => new vm.Script(script)).not.toThrow();
      expect(dialog.html).toContain("google.script.run");
      expect(dialog.html).not.toContain("SECRET_TOKEN");
    }
  });
});

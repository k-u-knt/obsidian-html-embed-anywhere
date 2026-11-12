// Regression tests for two security findings (run with `node --test test/security.test.js`).
//   F1: a web embed must never get allow-same-origin for a URL that is, or may be, Obsidian's own origin
//       (Android serves the app from http://localhost and vault files under /_capacitor_file_/).
//   F2: the "size WxH" option regexes must run in linear time on hostile option lines.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

// main.js requires "obsidian", which only exists inside the app: give it a minimal stub.
const platform = { isDesktopApp: false, isAndroidApp: false };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "obsidian") {
    class Stub {}
    return {
      Plugin: Stub, Modal: Stub, MarkdownRenderChild: Stub, MarkdownView: Stub, TFile: Stub,
      FuzzySuggestModal: Stub, Notice: Stub, PluginSettingTab: Stub, Setting: Stub, TFolder: Stub,
      FileView: Stub, normalizePath: (p) => p, setIcon: () => {}, Platform: platform,
    };
  }
  return origLoad.call(this, request, ...rest);
};
const proto = require(path.join(__dirname, "..", "main.js")).prototype;
Module._load = origLoad;

const ANDROID = "http://localhost";
const DESKTOP = "app://obsidian.md";

test("F1: URLs that are or may be Obsidian's own origin are flagged", () => {
  const bad = [
    "http://localhost/_capacitor_file_/storage/emulated/0/Documents/Shared/evil.html",
    "http://localhost/",
    "https://localhost/x",
    "http://LOCALHOST:8080/x",
    "http://localhost./x",
    "http://app.localhost/x",
    "http://127.0.0.1/x",
    "http://127.1.2.3:9000/x",
    "http://2130706433/x",          // 127.0.0.1 as a decimal integer
    "http://0x7f.1/x",              // 127.0.0.1 in hex shorthand
    "http://0.0.0.0/x",
    "http://[::1]/x",
    "http://[::ffff:127.0.0.1]/x",
    "https://example.com/_capacitor_file_/x.html",
    "https://example.com/%5Fcapacitor%5Ffile%5F/x.html",
    "https://example.com/_CAPACITOR_FILE_/x.html",
    "https://example.com/_capacitor_content_/x",
    "not a url",
  ];
  for (const u of bad) assert.strictEqual(proto.isLocalOrAppOrigin(u, ANDROID), true, u);
  // Same origin as the app, whatever it is.
  assert.strictEqual(proto.isLocalOrAppOrigin("https://obsidian.example/x", "https://obsidian.example"), true);
});

test("F1: ordinary web URLs are not flagged", () => {
  const good = [
    "https://example.com/",
    "https://plotly.com/javascript/",
    "http://example.org/page?q=localhost",
    "https://localhost.example.com/x",
    "https://128.0.0.1/x",
    "https://www.youtube.com/embed/abc",
  ];
  for (const u of good) {
    assert.strictEqual(proto.isLocalOrAppOrigin(u, ANDROID), false, u);
    assert.strictEqual(proto.isLocalOrAppOrigin(u, DESKTOP), false, u);
  }
});

test("F1: webSandboxFor drops allow-same-origin only for flagged URLs", () => {
  const unsafe = proto.webSandboxFor("http://localhost/_capacitor_file_/a.html", ANDROID);
  assert.ok(!/allow-same-origin/.test(unsafe), unsafe);
  assert.ok(/allow-scripts/.test(unsafe));
  const safe = proto.webSandboxFor("https://example.com/", ANDROID);
  assert.ok(/allow-same-origin/.test(safe), safe);
});

const self = { settings: { defaultHeight: "600" } };

test("F2: normal size / height options still parse", () => {
  const p = (...l) => proto.parseOptions.call(self, ["https://example.com", ...l]);
  assert.deepStrictEqual(p("size 800x600").fixed, { w: 800, h: 600 });
  assert.deepStrictEqual(p("size: 800 × 600").fixed, { w: 800, h: 600 });
  assert.deepStrictEqual(p("size=800x600").fixed, { w: 800, h: 600 });
  assert.deepStrictEqual(p("size800x600").fixed, { w: 800, h: 600 });
  assert.deepStrictEqual(p("SIZE 800 X 600").fixed, { w: 800, h: 600 });
  assert.strictEqual(p("size 800").fixed, null);
  assert.strictEqual(p("450").height, "450");
  assert.strictEqual(p("auto").height, "auto");
  assert.strictEqual(p().height, "600");
});

test("F2: hostile option lines are rejected in linear time", () => {
  const evil = ["size" + " ".repeat(50000) + "z", "size :" + " ".repeat(50000) + "z", "size 1" + " ".repeat(50000) + "z"];
  const t0 = process.hrtime.bigint();
  const o = proto.parseOptions.call(self, ["https://example.com", ...evil]);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(o.fixed, null);
  assert.ok(ms < 100, `parseOptions took ${ms.toFixed(1)} ms`);
});

test("F2: the canvas size-line regex is linear and still matches", () => {
  const re = proto.constructor.SIZE_LINE_RE;
  assert.ok(re instanceof RegExp);
  assert.ok(re.test("size 800x600"));
  assert.ok(re.test("  size: 800 × 600  "));
  assert.ok(!re.test("size 800"));
  const t0 = process.hrtime.bigint();
  re.test("size" + " ".repeat(50000) + "z");
  re.test(" ".repeat(50000) + "z");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 100, `size-line regex took ${ms.toFixed(1)} ms`);
});

test("Android: the plugin registers only an inert placeholder for html-embed blocks", async () => {
  const calls = [];
  const fake = {
    loadData: async () => ({}),
    addSettingTab: () => calls.push("settings"),
    registerDomEvent: () => calls.push("domEvent"),
    registerEvent: () => calls.push("event"),
    registerView: () => calls.push("view"),
    registerExtensions: () => calls.push("extensions"),
    addCommand: () => calls.push("command"),
    addRibbonIcon: () => calls.push("ribbon"),
    registerMarkdownCodeBlockProcessor: (name, fn) => { calls.push("processor:" + name); fake.processor = fn; },
  };
  platform.isAndroidApp = true;
  try { await proto.onload.call(fake); } finally { platform.isAndroidApp = false; }
  assert.deepStrictEqual(calls, ["processor:html-embed"]);
  const made = [];
  const el = { createDiv: (o) => { made.push(o); return {}; } };
  fake.processor("https://example.com/\n", el, {});
  assert.strictEqual(made.length, 1);
  assert.match(made[0].text, /Android/);
});

/* HTML Embed Anywhere — embed vault-local HTML files (Plotly, D3, reports) and web pages
 * in notes and canvas cards. Works on desktop and iOS/iPadOS.
 *
 * Ways to embed:
 *   • Command palette → "Embed HTML file…" / "Embed web page…"
 *   • Drag an .html file (Finder or Obsidian's file list) or a web link (browser) into a note
 *     or canvas → choose "Embed" or "Insert link" (configurable: ask / always embed / always link)
 *   • Right-click / long-press an .html file → "Embed in current note / canvas" / "Copy embed code"
 *
 * The block it writes:
 *   ```html-embed
 *   path/to/file.html      (vault path, bare file name, [[link]] — or an https:// URL)
 *   600                    (optional: height in px, or "auto" for local files)
 *   ```
 * Local files are read through the vault API and loaded into a sandboxed iframe as a blob, so they
 * do not rely on Obsidian's blocked local-file URLs. Their scripts run, but the frame gets an opaque
 * origin (no allow-same-origin): embedded code cannot reach Obsidian or the vault.
 */
const {
  Plugin, Modal, MarkdownRenderChild, MarkdownView, TFile, normalizePath,
  FuzzySuggestModal, Notice, PluginSettingTab, Setting, TFolder, setIcon, FileView,
} = require("obsidian");

const VIEW_TYPE_HTML = "html-embed-anywhere-file";

const DEFAULTS = {
  defaultHeight: "600",
  canvasWidth: 820,
  onDropFile: "ask", // ask | embed | link
  onDropUrl: "ask",  // ask | embed | link | obsidian (leave to Obsidian)
  importFolder: "",  // "" = Obsidian's attachment setting; otherwise a vault folder
  reuseIdentical: true, // reuse a vault file with identical content instead of importing a copy
  guardConfig: true,    // keep the pinned vault settings below, even if another device overwrites them
  pinnedConfig: null,   // e.g. { attachmentFolderPath: "Assets/Import", showUnsupportedFiles: true }
};
const GUARDED_KEYS = {
  attachmentFolderPath: "Default location for new attachments",
  showUnsupportedFiles: "Detect all file extensions",
};
const isHtml = (f) => f instanceof TFile && /^html?$/i.test(f.extension);
const isHtmlName = (n) => /\.html?$/i.test(n || "");
const isUrl = (s) => /^https?:\/\/\S+$/i.test((s || "").trim());
const LOCAL_SANDBOX = "allow-scripts allow-popups allow-forms allow-downloads allow-modals";
// A web page keeps its *own* origin (allow-same-origin), which is not Obsidian's, so it cannot reach the vault.
const WEB_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads allow-modals allow-presentation";

function shortUrl(u) {
  try { const x = new URL(u); return (x.hostname + (x.pathname === "/" ? "" : x.pathname)).replace(/\/$/, ""); }
  catch (_) { return u; }
}

// ---------------------------------------------------------------- modals
class HtmlPicker extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Pick an HTML file to embed (most recent first)…");
  }
  getItems() { return this.app.vault.getFiles().filter(isHtml).sort((a, b) => b.stat.mtime - a.stat.mtime); }
  getItemText(f) { return f.path; }
  onChooseItem(f) { this.onChoose(f); }
}

class UrlPrompt extends Modal {
  constructor(app, onSubmit) { super(app); this.onSubmit = onSubmit; }
  onOpen() {
    this.titleEl.setText("Embed web page");
    let value = "";
    const submit = () => {
      if (!isUrl(value)) { new Notice("Enter a full URL starting with http:// or https://"); return; }
      this.close(); this.onSubmit(value.trim());
    };
    new Setting(this.contentEl).setName("URL").addText((t) => {
      t.setPlaceholder("https://…").onChange((v) => (value = v));
      t.inputEl.addClass("html-embed-anywhere-url-input");
      t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
      window.setTimeout(() => t.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("Embed").setCta().onClick(submit));
  }
  onClose() { this.contentEl.empty(); }
}

class DropChoiceModal extends Modal {
  // Resolves to { choice: "embed" | "link" | null, remember: boolean }.
  constructor(app, { heading, name, question }, resolve) {
    super(app);
    this.opts = { heading, name, question };
    this.resolve = resolve;
    this.remember = false;
    this.done = false;
  }
  pick(choice) {
    if (this.done) return;
    this.done = true;
    this.resolve({ choice, remember: choice ? this.remember : false });
    this.close();
  }
  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.opts.heading);
    contentEl.addClass("html-embed-anywhere-drop-modal");
    contentEl.createDiv({ cls: "html-embed-anywhere-drop-name", text: this.opts.name });
    contentEl.createEl("p", { text: this.opts.question });
    new Setting(contentEl)
      .setName("Remember my choice")
      .setDesc("Change it later in Settings → HTML Embed Anywhere.")
      .addToggle((t) => t.setValue(false).onChange((v) => (this.remember = v)));
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    const embed = row.createEl("button", { text: "Embed", cls: "mod-cta" });
    embed.addEventListener("click", () => this.pick("embed"));
    row.createEl("button", { text: "Insert link" }).addEventListener("click", () => this.pick("link"));
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.pick(null));
    window.setTimeout(() => embed.focus(), 0);
  }
  onClose() {
    this.contentEl.empty();
    if (!this.done) { this.done = true; this.resolve({ choice: null, remember: false }); }
  }
}

// Opening an .html file (file list, links, quick switcher) shows it rendered inside Obsidian.
// Registering the extension also makes Obsidian treat .html as a known file type, so it is always
// listed in the file explorer — independent of "Detect all file extensions".
class HtmlFileView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.url = null;
    this.addAction("external-link", "Open in default browser", () => {
      if (this.file && this.app.openWithDefaultApp) this.app.openWithDefaultApp(this.file.path);
    });
  }
  getViewType() { return VIEW_TYPE_HTML; }
  getDisplayText() { return this.file ? this.file.basename : "HTML"; }
  getIcon() { return "file-code"; }
  canAcceptExtension(ext) { return /^html?$/i.test(ext); }
  async onLoadFile(file) {
    this.clear();
    this.contentEl.addClass("html-embed-anywhere-fileview");
    let html;
    try { html = await this.app.vault.read(file); }
    catch (e) { this.contentEl.createDiv({ cls: "html-embed-anywhere-error", text: "Could not read " + file.path }); return; }
    html = this.plugin.prepareHtml(file, html, { auto: false, fit: true, token: "view" });
    this.url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    this.contentEl.createEl("iframe", { attr: { src: this.url, sandbox: LOCAL_SANDBOX, title: file.name } });
  }
  async onUnloadFile() { this.clear(); }
  clear() {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.contentEl.empty();
  }
}

class HtmlFrame extends MarkdownRenderChild {
  constructor(el, url) { super(el); this.url = url; }
  onunload() { if (this.url) URL.revokeObjectURL(this.url); }
}

// ---------------------------------------------------------------- settings
class HtmlEmbedSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();
    new Setting(containerEl)
      .setName("Default height")
      .setDesc('Height written into new embeds: a number of pixels, or "auto" to fit the content (local files).')
      .addText((t) => t.setValue(s.defaultHeight).onChange(async (v) => { s.defaultHeight = v.trim() || "600"; await save(); }));
    new Setting(containerEl)
      .setName("Canvas card width")
      .setDesc("Width in pixels of cards created on a canvas.")
      .addText((t) => t.setValue(String(s.canvasWidth)).onChange(async (v) => { s.canvasWidth = parseInt(v, 10) || 820; await save(); }));
    new Setting(containerEl).setName("Protect vault settings").setHeading();
    const pinned = s.pinnedConfig || {};
    new Setting(containerEl)
      .setName("Keep these Obsidian settings")
      .setDesc("Settings sync between devices (iCloud etc.) can write an older copy of the vault's settings back, silently resetting them. When on, the plugin restores the values pinned below on every device where it runs. Change them here (or pin the current values) — changes made only in Obsidian's own settings would be restored.")
      .addToggle((t) => t.setValue(s.guardConfig !== false).onChange(async (v) => { s.guardConfig = v; await save(); if (v) this.plugin.enforceConfig(); }));
    new Setting(containerEl)
      .setName("Attachment folder")
      .setDesc(`Pinned "${GUARDED_KEYS.attachmentFolderPath}". Now: ${pinned.attachmentFolderPath === undefined ? "not pinned" : pinned.attachmentFolderPath}`)
      .addText((t) => t.setPlaceholder("e.g. Assets/Import").setValue(pinned.attachmentFolderPath || "")
        .onChange(async (v) => { s.pinnedConfig = Object.assign({}, s.pinnedConfig, { attachmentFolderPath: v.trim() || "/" }); await save(); this.plugin.enforceConfig(); }));
    new Setting(containerEl)
      .setName("Detect all file extensions")
      .setDesc(`Pinned "${GUARDED_KEYS.showUnsupportedFiles}" (shows PDFs, data files … in the file list).`)
      .addToggle((t) => t.setValue(!!pinned.showUnsupportedFiles)
        .onChange(async (v) => { s.pinnedConfig = Object.assign({}, s.pinnedConfig, { showUnsupportedFiles: v }); await save(); this.plugin.enforceConfig(); }));
    new Setting(containerEl)
      .setName("Pin current values")
      .setDesc("Take the values Obsidian is using right now on this device.")
      .addButton((b) => b.setButtonText("Pin current").onClick(async () => { await this.plugin.pinCurrentConfig(); this.display(); }));

    new Setting(containerEl).setName("Drag and drop").setHeading();
    new Setting(containerEl)
      .setName("Import folder")
      .setDesc("Where HTML files dropped from outside the vault are copied, so the vault stays self-contained. Leave empty to use Obsidian's attachment setting (Files and links).")
      .addText((t) => t.setPlaceholder("e.g. Assets/Import").setValue(s.importFolder || "")
        .onChange(async (v) => { s.importFolder = v.trim().replace(/^\/+|\/+$/g, ""); await save(); }));
    new Setting(containerEl)
      .setName("Reuse identical files")
      .setDesc("For any file you drop or paste from outside the vault (HTML, images, PDFs, data …): if a file with exactly the same content is already anywhere in the vault, whatever its name, embed/link that file instead of importing another copy. Only files of the same size are read to check. Turn off to leave non-HTML drops and pastes entirely to Obsidian.")
      .addToggle((t) => t.setValue(s.reuseIdentical !== false).onChange(async (v) => { s.reuseIdentical = v; await save(); }));
    new Setting(containerEl)
      .setName("When an HTML file is dropped")
      .setDesc("From Finder / Explorer or from Obsidian's file list, into a note or canvas.")
      .addDropdown((d) => d.addOptions({ ask: "Ask each time", embed: "Always embed", link: "Always insert a link" })
        .setValue(s.onDropFile).onChange(async (v) => { s.onDropFile = v; await save(); }));
    new Setting(containerEl)
      .setName("When a web link is dropped")
      .setDesc("A link or URL dragged in from a browser.")
      .addDropdown((d) => d.addOptions({ ask: "Ask each time", embed: "Always embed", link: "Always insert a link", obsidian: "Don't handle (Obsidian default)" })
        .setValue(s.onDropUrl).onChange(async (v) => { s.onDropUrl = v; await save(); }));
  }
}

// ---------------------------------------------------------------- plugin
module.exports = class HtmlEmbedAnywhere extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.addSettingTab(new HtmlEmbedSettings(this.app, this));

    // rendering
    this.frames = new Map(); // token -> iframe (auto height)
    this.registerDomEvent(window, "message", (e) => {
      const d = e.data;
      if (!d || typeof d !== "object" || !d.__htmlEmbedAnywhere) return;
      const fr = this.frames.get(d.__htmlEmbedAnywhere);
      if (fr && e.source === fr.contentWindow && d.h > 0) fr.style.height = Math.min(Math.max(d.h, 50), 4000) + "px";
    });
    this.registerMarkdownCodeBlockProcessor("html-embed", (src, el, ctx) => this.render(src, el, ctx));
    this.registerView(VIEW_TYPE_HTML, (leaf) => new HtmlFileView(leaf, this));
    // Protect vault settings against being reset by sync: check at start-up, whenever Obsidian
    // reloads its config, when the window regains focus, and every 30 s.
    this.app.workspace.onLayoutReady(async () => {
      if (!this.settings.pinnedConfig) await this.pinInitialConfig();
      this.enforceConfig();
    });
    try { this.registerEvent(this.app.vault.on("config-changed", () => window.setTimeout(() => this.enforceConfig(), 500))); } catch (_) { /* older Obsidian */ }
    this.registerDomEvent(window, "focus", () => this.enforceConfig());
    this.registerInterval(window.setInterval(() => this.enforceConfig(), 30000));
    try { this.registerExtensions(["html", "htm"], VIEW_TYPE_HTML); }
    catch (e) { console.warn("HTML Embed Anywhere: .html is already handled by another plugin", e); }

    // commands
    const pickFile = () => new HtmlPicker(this.app, (f) => this.embedIntoActiveView(f)).open();
    this.addCommand({ id: "embed-html-file", name: "Embed HTML file…", icon: "file-code", callback: pickFile });
    this.addCommand({
      id: "embed-web-page", name: "Embed web page…", icon: "globe",
      callback: () => new UrlPrompt(this.app, (u) => this.embedIntoActiveView(u)).open(),
    });
    this.addRibbonIcon("file-code", "Embed HTML file", pickFile);

    // file menu (right-click / long-press)
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!isHtml(file)) return;
      menu.addItem((i) => i.setTitle("Embed in current note / canvas").setIcon("file-code").onClick(() => this.embedIntoActiveView(file)));
      menu.addItem((i) => i.setTitle("Copy HTML embed code").setIcon("copy")
        .onClick(async () => { await navigator.clipboard.writeText(this.block(file)); new Notice("HTML embed code copied"); }));
    }));

    // drag & drop into notes and canvases. Drags that start inside Obsidian (moving text, etc.)
    // are never treated as web-link drops.
    this.dragFromInside = false;
    this.registerDomEvent(document, "dragstart", () => { this.dragFromInside = true; }, { capture: true });
    this.registerDomEvent(document, "dragend", () => { this.dragFromInside = false; }, { capture: true });
    // The pointer position is tracked from dragover: the coordinates on the final drop event are not
    // reliable for drags coming from outside the app (Finder, browsers) on every platform.
    this.lastDragPoint = null;
    this.registerDomEvent(document, "dragover", (e) => {
      if (e.clientX || e.clientY) this.lastDragPoint = { x: e.clientX, y: e.clientY, t: Date.now() };
      this.syncCanvasGeometry(e);
    }, { capture: true });

    // Work around an Obsidian canvas glitch: the canvas caches its on-screen position and only
    // refreshes it on resize. When the canvas tab moves without resizing (e.g. sliding in a stacked
    // tab group), the cache goes stale and every pointer position is mapped to the wrong place —
    // zoom centres somewhere else, hovering never finds a card (no resize handles or connection
    // points) and drops land away from the cursor. Before the canvas handles pointer/wheel events,
    // check the cache against the real position and refresh it if it moved.
    const sync = (e) => this.syncCanvasGeometry(e);
    this.registerDomEvent(document, "pointermove", sync, { capture: true, passive: true });
    this.registerDomEvent(document, "pointerdown", sync, { capture: true, passive: true });
    this.registerDomEvent(document, "wheel", sync, { capture: true, passive: true });
    this.registerDomEvent(document, "drop", (evt) => this.onDrop(evt), { capture: true });
    this.registerEvent(this.app.workspace.on("editor-paste", (evt, editor, info) => this.onPaste(evt, editor, info)));
  }

  async saveSettings() { await this.saveData(this.settings); }

  // First run: pin the current values, but never pin the "reset" defaults.
  async pinInitialConfig() {
    const att = this.app.vault.getConfig("attachmentFolderPath");
    const pin = {};
    if (att && att !== "/") pin.attachmentFolderPath = att;
    else if (this.settings.importFolder) pin.attachmentFolderPath = this.settings.importFolder;
    pin.showUnsupportedFiles = true;
    this.settings.pinnedConfig = pin;
    await this.saveSettings();
  }

  async pinCurrentConfig() {
    const cur = {};
    for (const k of Object.keys(GUARDED_KEYS)) cur[k] = this.app.vault.getConfig(k);
    this.settings.pinnedConfig = cur;
    await this.saveSettings();
    new Notice("Pinned: " + Object.entries(cur).map(([k, v]) => `${GUARDED_KEYS[k]} = ${v}`).join("; "));
  }

  // Restore pinned vault settings if something (usually a sync from another device) changed them.
  enforceConfig() {
    const pin = this.settings.pinnedConfig;
    if (this.settings.guardConfig === false || !pin) return;
    const fixed = [];
    for (const [k, v] of Object.entries(pin)) {
      if (!(k in GUARDED_KEYS) || v === undefined || v === null) continue;
      const cur = this.app.vault.getConfig(k);
      if (cur === v || (k === "showUnsupportedFiles" && !!cur === !!v)) continue;
      try { this.app.vault.setConfig(k, v); fixed.push(GUARDED_KEYS[k]); } catch (_) { /* ignore */ }
    }
    if (fixed.length) {
      const fe = this.app.workspace.getLeavesOfType("file-explorer")[0];
      if (fe && fe.view && fe.view.requestSort) fe.view.requestSort();
      new Notice("HTML Embed Anywhere restored: " + fixed.join(", ") + " (reset by settings sync).");
    }
  }

  // ---------------------------------------------------------------- drop handling
  dropTarget(evt) {
    const t = evt.target;
    const canvasLeaf = this.app.workspace.getLeavesOfType("canvas").find((l) => l.view.containerEl.contains(t));
    if (canvasLeaf && canvasLeaf.view.canvas) {
      if (t.closest && t.closest(".canvas-node-content .cm-editor")) return null; // typing inside a card: leave it
      return { kind: "canvas", view: canvasLeaf.view };
    }
    const mdLeaf = this.app.workspace.getLeavesOfType("markdown").find((l) => l.view.editor && l.view.contentEl.contains(t));
    if (mdLeaf && !(mdLeaf.view.getMode && mdLeaf.view.getMode() === "preview")) return { kind: "note", view: mdLeaf.view };
    return null;
  }

  droppedUrl(evt) {
    const dt = evt.dataTransfer;
    if (!dt || this.dragFromInside || (dt.files && dt.files.length)) return null;
    const list = (dt.getData("text/uri-list") || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    const url = list.length ? list[0] : (dt.getData("text/plain") || "").trim();
    if (!isUrl(url)) return null;
    let title = "";
    try {
      const html = dt.getData("text/html");
      if (html) { const a = new DOMParser().parseFromString(html, "text/html").querySelector("a"); title = a ? a.textContent.trim() : ""; }
    } catch (_) { /* no title available */ }
    return { url, title: title && title !== url ? title : "" };
  }

  onDrop(evt) {
    const target = this.dropTarget(evt);
    if (!target) return;
    const internal = this.draggedVaultHtml();
    const external = internal.length ? [] : this.droppedExternalHtml(evt);
    const web = internal.length || external.length ? null : this.droppedUrl(evt);
    if (!internal.length && !external.length && !web) {
      const other = this.settings.reuseIdentical ? Array.from((evt.dataTransfer && evt.dataTransfer.files) || []) : [];
      if (other.length) this.onDropOtherFiles(evt, target, other);
      return;
    }
    const mode = web ? this.settings.onDropUrl : this.settings.onDropFile;
    if (mode === "obsidian") return;

    evt.preventDefault();
    evt.stopPropagation();
    if (this.app.dragManager) this.app.dragManager.draggable = null;
    this.dragFromInside = false;

    // Remember where it was dropped before any dialog opens.
    this.syncCanvasGeometry(evt, true);
    const pt = this.dropPoint(evt);
    this.lastDropInfo = { drop: { x: evt.clientX, y: evt.clientY }, used: pt, target: target.kind, at: new Date().toISOString() }; // for troubleshooting
    const canvas = target.kind === "canvas" ? target.view.canvas : null;
    const where = target.kind === "note"
      ? this.offsetAt(target.view.editor, pt)
      : (canvas.posFromClient ? canvas.posFromClient(pt) : canvas.posFromEvt ? canvas.posFromEvt({ clientX: pt.x, clientY: pt.y }) : null);
    this.lastDropInfo.where = where;
    if (canvas) this.lastDropInfo.view = { tx: canvas.tx, ty: canvas.ty, scale: canvas.scale, rect: (() => { const r = canvas.wrapperEl.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })() };

    (async () => {
      let choice = mode;
      if (mode === "ask") {
        const name = web ? (web.title ? `${web.title} — ${web.url}` : web.url) : (internal.length ? internal : external).map((f) => f.name).join(", ");
        const res = await this.askDropChoice(!!web, name, target.kind);
        if (!res.choice) return;
        choice = res.choice;
        if (res.remember) {
          if (web) this.settings.onDropUrl = choice; else this.settings.onDropFile = choice;
          await this.saveSettings();
          new Notice(`Dropped ${web ? "web links" : "HTML files"} will now always be ${choice === "embed" ? "embedded" : "inserted as links"}.`);
        }
      }
      const items = web ? [web] : internal.length ? internal : await this.importExternal(external, target.view.file ? target.view.file.path : "");
      if (!items.length) return;
      if (target.kind === "note") {
        const ed = target.view.editor;
        if (where != null) ed.setCursor(ed.offsetToPos(Math.min(where, ed.getValue().length)));
        for (const it of items) { if (choice === "embed") this.insertBlock(ed, it); else this.insertLink(ed, it, target.view.file); }
      } else {
        items.forEach((it, i) => {
          const p = where && { x: where.x + i * 40, y: where.y + i * 40 };
          if (choice === "embed") this.addCanvasCard(target.view.canvas, it, p); else this.addCanvasLink(target.view.canvas, it, p);
        });
      }
    })();
  }

  // Any other files dropped from outside the vault (images, PDFs, data, mixed selections …) are
  // handled like Obsidian does — imported into the attachment folder and embedded at the drop point —
  // except that a file whose content is already in the vault is reused instead of copied again.
  onDropOtherFiles(evt, target, files) {
    evt.preventDefault();
    evt.stopPropagation();
    this.syncCanvasGeometry(evt, true);
    const pt = this.dropPoint(evt);
    const canvas = target.kind === "canvas" ? target.view.canvas : null;
    const where = target.kind === "note" ? this.offsetAt(target.view.editor, pt) : canvas.posFromClient ? canvas.posFromClient(pt) : null;
    (async () => {
      const src = target.view.file ? target.view.file.path : "";
      const items = await this.importExternal(files, src, { attachment: true });
      if (!items.length) return;
      if (target.kind === "note") {
        const ed = target.view.editor;
        if (where != null) ed.setCursor(ed.offsetToPos(Math.min(where, ed.getValue().length)));
        this.insertEmbeds(ed, items, target.view.file);
      } else {
        items.forEach((f, i) => {
          const at = where ? { x: where.x + i * 40, y: where.y + i * 40 } : this.centerPos(canvas, 400, 400);
          try { canvas.createFileNode({ file: f, pos: at, size: { width: 400, height: 400 }, focus: false, save: true }); }
          catch (e) { new Notice("Could not add " + f.name + " to the canvas: " + e.message); }
        });
        if (canvas.requestSave) canvas.requestSave();
      }
    })();
  }

  insertEmbeds(editor, files, sourceFile) {
    const text = files.map((f) => "!" + this.app.fileManager.generateMarkdownLink(f, sourceFile ? sourceFile.path : "")).join("\n");
    const cur = editor.getCursor();
    const start = editor.posToOffset(cur);
    editor.replaceRange(text, cur);
    editor.setCursor(editor.offsetToPos(start + text.length));
  }

  // Pasted files (e.g. screenshots): same de-duplication as drops.
  onPaste(evt, editor, info) {
    if (evt.defaultPrevented || !this.settings.reuseIdentical) return;
    const cd = evt.clipboardData;
    const files = Array.from((cd && cd.files) || []);
    if (!files.length || (cd.getData("text/plain") || "").trim()) return; // text pastes: leave to Obsidian
    evt.preventDefault();
    const sourceFile = info && info.file;
    (async () => {
      const stamp = window.moment ? window.moment().format("YYYYMMDDHHmmss") : String(Date.now());
      const rename = (f) => (/^image\.(png|jpe?g|gif|webp)$/i.test(f.name) ? `Pasted image ${stamp}.${f.name.split(".").pop()}` : f.name);
      const items = await this.importExternal(files, sourceFile ? sourceFile.path : "", { attachment: true, rename });
      if (items.length) this.insertEmbeds(editor, items, sourceFile);
    })();
  }

  askDropChoice(isWeb, name, kind) {
    const where = kind === "canvas" ? "this canvas" : "this note";
    const opts = isWeb
      ? { heading: "Web link dropped", name, question: `Embed the page in ${where}, or insert a link to it? Some sites refuse to be embedded and stay blank.` }
      : { heading: "HTML file dropped", name, question: `Embed it (live and interactive) in ${where}, or insert a link to the file?` };
    return new Promise((resolve) => new DropChoiceModal(this.app, opts, resolve).open());
  }

  syncCanvasGeometry(e, force) {
    const now = Date.now();
    if (!force && e && e.type === "pointermove" && now - (this.lastGeometrySync || 0) < 120) return;
    this.lastGeometrySync = now;
    const t = e && e.target;
    const wrapper = t && t.closest ? t.closest(".canvas-wrapper") : null;
    if (!wrapper) return;
    const leaf = this.app.workspace.getLeavesOfType("canvas").find((l) => l.view.canvas && l.view.canvas.wrapperEl === wrapper);
    const c = leaf && leaf.view.canvas;
    if (!c || !c.canvasRect || typeof c.onResize !== "function") return;
    const r = wrapper.getBoundingClientRect(), cr = c.canvasRect;
    if (Math.abs(cr.left - r.left) > 1 || Math.abs(cr.top - r.top) > 1 || Math.abs(cr.width - r.width) > 1 || Math.abs(cr.height - r.height) > 1) {
      try { c.onResize(); } catch (_) { /* leave the canvas alone */ }
    }
  }

  dropPoint(evt) {
    const lp = this.lastDragPoint;
    if (lp && Date.now() - lp.t < 1000) return { x: lp.x, y: lp.y };
    return { x: evt.clientX, y: evt.clientY };
  }

  offsetAt(editor, pt) {
    try {
      const off = editor.cm && editor.cm.posAtCoords({ x: pt.x, y: pt.y });
      return off != null ? off : editor.posToOffset(editor.getCursor());
    } catch (_) { return null; }
  }

  draggedVaultHtml() {
    const d = this.app.dragManager && this.app.dragManager.draggable;
    if (!d) return [];
    if (d.type === "file" && isHtml(d.file)) return [d.file];
    if (d.type === "files" && Array.isArray(d.files)) {
      const html = d.files.filter(isHtml);
      return html.length === d.files.length ? html : []; // mixed selection: leave to Obsidian
    }
    return [];
  }

  droppedExternalHtml(evt) {
    const list = Array.from((evt.dataTransfer && evt.dataTransfer.files) || []);
    if (!list.length || !list.every((f) => isHtmlName(f.name))) return []; // mixed drop: leave to Obsidian
    return list;
  }

  async importExternal(files, sourcePath, opts = {}) {
    // Copy dropped files into the vault — unless a file with exactly the same content is already
    // there (under any name, in any folder), in which case that file is reused.
    // HTML files go to the plugin's Import folder; other files (opts.attachment) follow Obsidian's
    // attachment setting, exactly like Obsidian's own drop/paste handling.
    const out = [], reused = [];
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        const name = (opts.rename && opts.rename(f)) || f.name;
        const useOwn = this.settings.importFolder && !opts.attachment;
        const folder = useOwn ? await this.importFolderFor(name, sourcePath) : await this.attachmentFolderFor(name, sourcePath);
        const same = this.settings.reuseIdentical ? await this.findIdentical(buf, folder, name) : null;
        if (same) { out.push(same); reused.push(same.path); continue; }
        const path = useOwn
          ? this.availablePath(folder, name)
          : await this.app.fileManager.getAvailablePathForAttachment(name, sourcePath);
        out.push(await this.app.vault.createBinary(path, buf));
      } catch (e) { new Notice("Could not import " + f.name + ": " + e.message); }
    }
    const added = out.map((f) => f.path).filter((p) => !reused.includes(p));
    if (added.length) new Notice("Imported: " + added.join(", "));
    if (reused.length) new Notice("Identical file already in the vault, reused: " + reused.join(", "));
    return out;
  }

  // Content-based de-duplication. Only files with exactly the same byte size are candidates (a free
  // check — sizes come from the vault index), so almost nothing is read. Candidates are compared by
  // SHA-256; hashes are cached per path/size/mtime so repeated drops don't re-read files.
  async findIdentical(buf, preferFolder, preferName) {
    const size = buf.byteLength;
    const cands = this.app.vault.getFiles().filter((f) => f.stat.size === size);
    if (!cands.length) return null;
    const rank = (f) => (f.parent && f.parent.path === (preferFolder || "/") ? 0 : 2) + (f.name === preferName ? 0 : 1);
    cands.sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || a.stat.ctime - b.stat.ctime); // prefer the "original"
    const want = await this.digest(buf);
    for (const f of cands) {
      try { if ((await this.hashOf(f)) === want) return f; } catch (_) { /* unreadable: skip */ }
    }
    return null;
  }

  async hashOf(file) {
    if (!this.hashCache) this.hashCache = new Map();
    const key = file.path + "|" + file.stat.size + "|" + file.stat.mtime;
    let h = this.hashCache.get(key);
    if (!h) { h = await this.digest(await this.app.vault.readBinary(file)); this.hashCache.set(key, h); }
    return h;
  }

  async digest(buf) {
    if (window.crypto && window.crypto.subtle) {
      const d = new Uint8Array(await window.crypto.subtle.digest("SHA-256", buf));
      return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    // Fallback (no WebCrypto): 64-bit FNV-1a over the bytes, plus the length.
    const a = new Uint8Array(buf);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < a.length; i++) { h1 = Math.imul(h1 ^ a[i], 16777619) >>> 0; h2 = Math.imul(h2 ^ a[i], 2246822519) >>> 0; }
    return a.length + ":" + h1.toString(16) + h2.toString(16);
  }

  async attachmentFolderFor(name, sourcePath) {
    const p = await this.app.fileManager.getAvailablePathForAttachment(name, sourcePath);
    return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  }

  async importFolderFor(name, sourcePath) {
    if (this.settings.importFolder) {
      const folder = normalizePath(this.settings.importFolder);
      if (!(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) await this.app.vault.createFolder(folder);
      return folder;
    }
    const p = await this.app.fileManager.getAvailablePathForAttachment(name, sourcePath);
    return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  }

  availablePath(folder, name) {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
    const pre = folder ? folder + "/" : "";
    let p = normalizePath(pre + name), i = 1;
    while (this.app.vault.getAbstractFileByPath(p)) p = normalizePath(`${pre}${stem} ${i++}${ext}`);
    return p;
  }

  // ---------------------------------------------------------------- inserting
  target(item) { return item instanceof TFile ? item.path : typeof item === "string" ? item : item.url; }

  block(item, height) {
    return "```html-embed\n" + this.target(item) + "\n" + (height || this.settings.defaultHeight) + "\n```\n";
  }

  linkText(item, sourceFile) {
    if (item instanceof TFile) return this.app.fileManager.generateMarkdownLink(item, sourceFile ? sourceFile.path : "");
    const url = this.target(item);
    const label = ((item && item.title) || shortUrl(url)).replace(/[\[\]]/g, "");
    return `[${label}](${url})`;
  }

  insertBlock(editor, item) {
    // Put the block on its own lines, separated from neighbouring text by blank lines.
    const ln = editor.getCursor().line;
    const line = editor.getLine(ln);
    const blk = this.block(item).replace(/\n$/, "");
    const nextBlank = ln + 1 >= editor.lineCount() || editor.getLine(ln + 1).trim() === "";
    let from, to, text;
    if (line.trim() === "") {
      const prevBlank = ln === 0 || editor.getLine(ln - 1).trim() === "";
      from = { line: ln, ch: 0 }; to = { line: ln, ch: line.length };
      text = (prevBlank ? "" : "\n") + blk + (nextBlank ? "" : "\n");
    } else {
      from = to = { line: ln, ch: line.length };
      text = "\n\n" + blk + (nextBlank ? "" : "\n");
    }
    const start = editor.posToOffset(from);
    editor.replaceRange(text, from, to);
    editor.setCursor(editor.offsetToPos(start + text.length));
  }

  insertLink(editor, item, sourceFile) {
    const link = this.linkText(item, sourceFile);
    let cur = editor.getCursor();
    const lineText = editor.getLine(cur.line);
    let text;
    if (/^\s*(```|~~~)/.test(lineText)) {
      // Never write onto a code-fence line (e.g. right after an embed): start a new paragraph.
      cur = { line: cur.line, ch: lineText.length };
      text = "\n\n" + link;
    } else {
      const before = lineText.slice(0, cur.ch);
      text = (before && !/\s$/.test(before) ? " " : "") + link + " ";
    }
    const start = editor.posToOffset(cur);
    editor.replaceRange(text, cur);
    editor.setCursor(editor.offsetToPos(start + text.length));
  }

  centerPos(canvas, w, h) {
    if (!canvas.getViewportBBox) return { x: 0, y: 0 };
    const b = canvas.getViewportBBox();
    return { x: (b.minX + b.maxX) / 2 - w / 2, y: (b.minY + b.maxY) / 2 - h / 2 };
  }

  addCanvasCard(canvas, item, pos) {
    const h = parseInt(this.settings.defaultHeight, 10) || 600;
    const w = this.settings.canvasWidth || 820;
    const at = pos || this.centerPos(canvas, w, h);
    const size = { width: w, height: h + 40 };
    try {
      if (!(item instanceof TFile) && canvas.createLinkNode) {
        // Web pages: Obsidian's own web card (resizable, interactive).
        canvas.createLinkNode({ url: this.target(item), pos: at, size, focus: false, save: true });
      } else {
        const node = canvas.createTextNode({ pos: at, size, text: this.block(item, String(h)), focus: false, save: true });
        if (this.lastDropInfo) this.lastDropInfo.placed = { pos, at, node: node ? [node.x, node.y] : null };
      }
      if (canvas.requestSave) canvas.requestSave();
    } catch (e) {
      navigator.clipboard.writeText(this.block(item, String(h)));
      new Notice("Could not add a canvas card automatically — embed code copied; paste it into a card.");
    }
  }

  addCanvasLink(canvas, item, pos) {
    const at = pos || this.centerPos(canvas, 400, 80);
    try {
      if (item instanceof TFile && canvas.createFileNode) {
        canvas.createFileNode({ file: item, pos: at, size: { width: 400, height: 120 }, focus: false, save: true });
      } else {
        canvas.createTextNode({ pos: at, size: { width: 400, height: 80 }, text: this.linkText(item, null), focus: false, save: true });
      }
      if (canvas.requestSave) canvas.requestSave();
    } catch (e) {
      navigator.clipboard.writeText(this.linkText(item, null));
      new Notice("Could not add a canvas card automatically — link copied.");
    }
  }

  embedIntoActiveView(item) {
    const leaf = this.app.workspace.getMostRecentLeaf ? this.app.workspace.getMostRecentLeaf() : this.app.workspace.activeLeaf;
    const view = leaf && leaf.view;
    if (view && view.getViewType && view.getViewType() === "canvas" && view.canvas) return this.addCanvasCard(view.canvas, item);
    if (view instanceof MarkdownView) {
      if (view.getMode && view.getMode() === "preview") { new Notice("Switch the note to editing mode to insert."); return; }
      return this.insertBlock(view.editor, item);
    }
    navigator.clipboard.writeText(this.block(item));
    new Notice("No note or canvas open — embed code copied to clipboard.");
  }

  // ---------------------------------------------------------------- rendering
  showError(el, msg) { el.createDiv({ cls: "html-embed-anywhere-error", text: "html-embed: " + msg }); }

  resolve(raw, sourcePath) {
    const p = raw.trim().replace(/^!?\[\[/, "").replace(/\]\]$/, "").replace(/\|.*$/, "").replace(/^<|>$/g, "");
    const direct = this.app.vault.getAbstractFileByPath(normalizePath(p));
    if (direct instanceof TFile) return direct;
    const viaLink = this.app.metadataCache.getFirstLinkpathDest(p, sourcePath);
    return viaLink instanceof TFile ? viaLink : null;
  }

  // Block options after the first line: a height ("600" / "auto") and optionally "size WxH",
  // which fixes the embed (and a Plotly figure inside it) at that size instead of following the card.
  parseOptions(lines) {
    const o = { height: null, fixed: null };
    for (const raw of lines.slice(1)) {
      const l = raw.toLowerCase();
      const m = l.match(/^size\s*[:=]?\s*(\d+)\s*[x×]\s*(\d+)$/);
      if (m) o.fixed = { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
      else if (l === "auto" || /^\d+$/.test(l)) o.height = l;
    }
    if (!o.height) o.height = (this.settings.defaultHeight || "600").toLowerCase();
    return o;
  }

  // Adds <base> (relative assets), the Plotly-fit / unhover helper and, for "auto" height, the
  // content-height reporter to a local HTML document before it is loaded into a sandboxed frame.
  prepareHtml(file, html, { auto, fit, token }) {
    const base = this.app.vault.getResourcePath(file).split("?")[0].replace(/[^/]*$/, "");
    const head = /<base\s/i.test(html) ? "" : `<base href="${base}">`;
    const tail = auto
      ? `<script>(function(){var t=${JSON.stringify(token)},last=0;function s(){var b=document.body;if(!b)return;var m=0;for(var i=0;i<b.children.length;i++){var r=b.children[i].getBoundingClientRect();if(r.height)m=Math.max(m,r.bottom+window.scrollY)}var h=Math.ceil(m+parseFloat(getComputedStyle(b).marginBottom||0));if(h&&h!==last){last=h;parent.postMessage({__htmlEmbedAnywhere:t,h:h},"*")}}addEventListener("load",s);if(window.ResizeObserver)new ResizeObserver(s).observe(document.body||document.documentElement);})();</script>`
      : "";
    if (head) {
      if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + head);
      else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (m) => m + head);
      else if (/^\s*<!doctype[^>]*>/i.test(html)) html = html.replace(/^\s*<!doctype[^>]*>/i, (m) => m + head);
      else html = head + html;
    }
    // Helper inside the frame: a single Plotly figure is resized to fill the frame (so it follows the
    // card / note size, or the fixed size), and hover labels are cleared when the embed is locked.
    const helper = `<script>(function(){var FIT=${fit ? "true" : "false"};` +
      `function plots(){return window.Plotly?Array.prototype.slice.call(document.querySelectorAll(".js-plotly-plot")):[]}` +
      `function fit(){if(!FIT)return;var p=plots();if(p.length!==1)return;var d=document.documentElement;d.style.overflow="hidden";document.body.style.margin="0";` +
      `var w=d.clientWidth,h=d.clientHeight;if(w>20&&h>20){try{Plotly.relayout(p[0],{width:w,height:h})}catch(e){}}}` +
      `var q=0;function later(){cancelAnimationFrame(q);q=requestAnimationFrame(fit)}` +
      `addEventListener("load",function(){fit();setTimeout(fit,300)});addEventListener("resize",later);` +
      `addEventListener("message",function(e){var m=e.data;if(!m||!m.__htmlEmbedAnywhereCmd)return;` +
      `if(m.__htmlEmbedAnywhereCmd==="unhover"){plots().forEach(function(g){try{Plotly.Fx.unhover(g)}catch(x){}})}` +
      `if(m.__htmlEmbedAnywhereCmd==="fit")later()});})();</script>`;
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, helper + "</body>") : html + helper;
    if (tail) html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, tail + "</body>") : html + tail;

    return html;
  }

  async render(src, el, ctx) {
    const lines = src.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return this.showError(el, "add a file path or URL on the first line");
    const opts = this.parseOptions(lines);
    const hArg = opts.height;

    if (isUrl(lines[0])) return this.renderUrl(lines[0], hArg, el, ctx, opts);

    const file = this.resolve(lines[0], ctx.sourcePath);
    if (!file) return this.showError(el, "file not found: " + lines[0]);
    const auto = hArg === "auto" && !opts.fixed;
    const height = opts.fixed ? opts.fixed.h : auto ? 400 : parseInt(hArg, 10) || 600;

    let html;
    try { html = await this.app.vault.read(file); }
    catch (err) { return this.showError(el, "could not read " + file.path + " (" + err.message + ")"); }

    const token = Math.random().toString(36).slice(2);
    html = this.prepareHtml(file, html, { auto, fit: !auto, token });
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const wrap = el.createDiv({ cls: "html-embed-anywhere" });
    const iframe = wrap.createEl("iframe", { attr: { src: url, sandbox: LOCAL_SANDBOX, title: file.name } });
    iframe.style.height = height + "px";
    if (opts.fixed) { iframe.style.width = opts.fixed.w + "px"; wrap.addClass("is-fixed"); }
    const cap = wrap.createDiv({ cls: "html-embed-anywhere-caption", text: file.name });
    cap.setAttr("title", "Open " + file.path + " in the default browser");
    cap.addEventListener("click", () => { if (this.app.openWithDefaultApp) this.app.openWithDefaultApp(file.path); });
    const child = new HtmlFrame(wrap, url);
    if (auto) { this.frames.set(token, iframe); child.register(() => this.frames.delete(token)); }
    ctx.addChild(child);
    this.fitToCanvasCard(wrap, iframe, cap, child, opts);
  }

  renderUrl(url, hArg, el, ctx, opts) {
    const height = (opts && opts.fixed && opts.fixed.h) || parseInt(hArg, 10) || parseInt(this.settings.defaultHeight, 10) || 600;
    const wrap = el.createDiv({ cls: "html-embed-anywhere is-web" });
    const iframe = wrap.createEl("iframe", {
      attr: { src: url, sandbox: WEB_SANDBOX, allow: "fullscreen; clipboard-write; encrypted-media; picture-in-picture", title: url },
    });
    iframe.style.height = height + "px";
    if (opts && opts.fixed) { iframe.style.width = opts.fixed.w + "px"; wrap.addClass("is-fixed"); }
    const cap = wrap.createEl("a", { cls: "html-embed-anywhere-caption external-link", text: shortUrl(url), href: url });
    cap.setAttr("title", "Open in browser — if the frame stays blank, this site does not allow embedding");
    const child = new MarkdownRenderChild(wrap);
    ctx.addChild(child);
    this.fitToCanvasCard(wrap, iframe, cap, child, opts);
  }

  // Canvas cards get two controls under the embed:
  //   • Size  — "Fit card": the embed (and a Plotly figure in it) follows the card size;
  //             "Fixed W×H": it keeps that size whatever the card size (saved in the card as "size WxH").
  //   • Lock  — locked (default): the embed is a static picture; the card can be dragged, resized and
  //             connected, and hovering shows nothing. Unlocked: hover, zoom, pan, read values.
  //             It locks again when the card is deselected.
  fitToCanvasCard(wrap, iframe, cap, child, opts, tries = 0) {
    const card = wrap.closest(".canvas-node-content");
    if (!card) {
      if (!wrap.isConnected && tries < 30) window.requestAnimationFrame(() => this.fitToCanvasCard(wrap, iframe, cap, child, opts, tries + 1));
      return;
    }
    wrap.addClass("is-in-canvas");
    this.frames.forEach((fr, t) => { if (fr === iframe) this.frames.delete(t); }); // card size wins over "auto"
    const fixed = opts && opts.fixed;

    const bar = createDiv({ cls: "html-embed-anywhere-bar" });
    cap.replaceWith(bar);
    bar.appendChild(cap);
    const tools = bar.createDiv({ cls: "html-embed-anywhere-tools" });
    const mkBtn = (cls, icon, label, tip) => {
      const b = tools.createEl("button", { cls: "html-embed-anywhere-btn clickable-icon " + cls, attr: { "aria-label": tip } });
      setIcon(b, icon);
      b.createSpan({ text: label });
      return b;
    };
    const setBtn = (b, icon, label, tip) => { b.empty(); setIcon(b, icon); b.createSpan({ text: label }); b.setAttr("aria-label", tip); };

    // size toggle
    const sizeBtn = mkBtn("html-embed-anywhere-size", fixed ? "pin" : "maximize-2",
      fixed ? `Fixed ${fixed.w}×${fixed.h}` : "Fit card",
      fixed ? "Size is fixed — click to follow the card size again" : "Follows the card size — click to fix the current size");
    if (fixed) sizeBtn.addClass("is-active");
    sizeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const next = fixed ? null : { w: Math.round(iframe.clientWidth), h: Math.round(iframe.clientHeight) };
      this.setCanvasCardSize(wrap, next);
    });

    // lock / interact toggle
    const lockBtn = mkBtn("html-embed-anywhere-interact", "lock", "Locked", "Locked (static) — click to interact with the plot");
    const setInteractive = (on) => {
      if (wrap.hasClass("is-interactive") === on) return;
      wrap.toggleClass("is-interactive", on);
      lockBtn.toggleClass("is-active", on);
      if (on) setBtn(lockBtn, "unlock", "Interacting", "Interactive — click to lock (static)");
      else {
        setBtn(lockBtn, "lock", "Locked", "Locked (static) — click to interact with the plot");
        try { iframe.contentWindow && iframe.contentWindow.postMessage({ __htmlEmbedAnywhereCmd: "unhover" }, "*"); } catch (_) { /* ignore */ }
      }
    };
    lockBtn.addEventListener("click", (e) => { e.stopPropagation(); setInteractive(!wrap.hasClass("is-interactive")); });
    const node = wrap.closest(".canvas-node");
    if (node) {
      const mo = new MutationObserver(() => { if (!node.hasClass("is-focused")) setInteractive(false); });
      mo.observe(node, { attributes: true, attributeFilter: ["class"] });
      child.register(() => mo.disconnect());
    }

    if (fixed) return; // fixed: the embed keeps its size; the card scrolls if it is smaller

    const fit = () => {
      if (!card.clientHeight) return;
      const cr = card.getBoundingClientRect();
      const scale = cr.height / card.clientHeight || 1; // canvas zoom
      const top = (iframe.getBoundingClientRect().top - cr.top) / scale;
      const h = Math.floor(card.clientHeight - top - bar.offsetHeight - 16);
      if (h > 40) iframe.style.height = h + "px";
    };
    const ro = new ResizeObserver(() => fit());
    ro.observe(card);
    child.register(() => ro.disconnect());
    fit();
  }

  // Write (or remove) the "size WxH" option into the canvas card's text; the card then re-renders.
  setCanvasCardSize(wrap, size) {
    const nodeEl = wrap.closest(".canvas-node");
    const leaf = this.app.workspace.getLeavesOfType("canvas").find((l) => l.view.canvas && l.view.containerEl.contains(wrap));
    const node = leaf && [...leaf.view.canvas.nodes.values()].find((n) => n.nodeEl === nodeEl);
    if (!node) { new Notice("Could not find the canvas card."); return; }
    const data = node.getData();
    if (typeof data.text !== "string") return;
    const text = data.text.replace(/```html-embed\n([\s\S]*?)```/, (all, body) => {
      const kept = body.split("\n").filter((l) => l.trim() && !/^\s*size\s*[:=]?\s*\d+\s*[x×]\s*\d+\s*$/i.test(l));
      if (size) kept.push(`size ${size.w}x${size.h}`);
      return "```html-embed\n" + kept.join("\n") + "\n```";
    });
    if (text === data.text) return;
    if (typeof node.setText === "function") node.setText(text);
    else node.setData(Object.assign({}, data, { text }));
    if (leaf.view.canvas.requestSave) leaf.view.canvas.requestSave();
  }
};

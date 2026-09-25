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
  FuzzySuggestModal, Notice, PluginSettingTab, Setting, TFolder, setIcon,
} = require("obsidian");

const DEFAULTS = {
  defaultHeight: "600",
  canvasWidth: 820,
  onDropFile: "ask", // ask | embed | link
  onDropUrl: "ask",  // ask | embed | link | obsidian (leave to Obsidian)
  importFolder: "",  // "" = Obsidian's attachment setting; otherwise a vault folder
  reuseIdentical: true, // reuse a vault file with identical content instead of importing a copy
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
    new Setting(containerEl).setName("Drag and drop").setHeading();
    new Setting(containerEl)
      .setName("Import folder")
      .setDesc("Where HTML files dropped from outside the vault are copied, so the vault stays self-contained. Leave empty to use Obsidian's attachment setting (Files and links).")
      .addText((t) => t.setPlaceholder("e.g. Assets/Import").setValue(s.importFolder || "")
        .onChange(async (v) => { s.importFolder = v.trim().replace(/^\/+|\/+$/g, ""); await save(); }));
    new Setting(containerEl)
      .setName("Reuse identical files")
      .setDesc("If a file with exactly the same content is already anywhere in the vault (whatever its name), link to it instead of importing another copy. Only files of the same size are read to check.")
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
    this.registerDomEvent(document, "drop", (evt) => this.onDrop(evt), { capture: true });
  }

  async saveSettings() { await this.saveData(this.settings); }

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
    if (!internal.length && !external.length && !web) return;
    const mode = web ? this.settings.onDropUrl : this.settings.onDropFile;
    if (mode === "obsidian") return;

    evt.preventDefault();
    evt.stopPropagation();
    if (this.app.dragManager) this.app.dragManager.draggable = null;
    this.dragFromInside = false;

    // Remember where it was dropped before any dialog opens.
    const where = target.kind === "note"
      ? this.offsetAt(target.view.editor, evt)
      : (target.view.canvas.posFromEvt ? target.view.canvas.posFromEvt(evt) : null);

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

  askDropChoice(isWeb, name, kind) {
    const where = kind === "canvas" ? "this canvas" : "this note";
    const opts = isWeb
      ? { heading: "Web link dropped", name, question: `Embed the page in ${where}, or insert a link to it? Some sites refuse to be embedded and stay blank.` }
      : { heading: "HTML file dropped", name, question: `Embed it (live and interactive) in ${where}, or insert a link to the file?` };
    return new Promise((resolve) => new DropChoiceModal(this.app, opts, resolve).open());
  }

  offsetAt(editor, evt) {
    try {
      const off = editor.cm && editor.cm.posAtCoords({ x: evt.clientX, y: evt.clientY });
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

  async importExternal(files, sourcePath) {
    // Copy dropped files into the vault — unless a file with exactly the same content is already
    // there (under any name, in any folder), in which case that file is reused.
    const out = [], reused = [];
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        const folder = await this.importFolderFor(f.name, sourcePath);
        const same = this.settings.reuseIdentical ? await this.findIdentical(buf, folder, f.name) : null;
        if (same) { out.push(same); reused.push(same.path); continue; }
        const path = this.settings.importFolder
          ? this.availablePath(folder, f.name)
          : await this.app.fileManager.getAvailablePathForAttachment(f.name, sourcePath);
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
        canvas.createTextNode({ pos: at, size, text: this.block(item, String(h)), focus: false, save: true });
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

  async render(src, el, ctx) {
    const lines = src.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return this.showError(el, "add a file path or URL on the first line");
    const hArg = (lines[1] || this.settings.defaultHeight || "600").toLowerCase();

    if (isUrl(lines[0])) return this.renderUrl(lines[0], hArg, el, ctx);

    const file = this.resolve(lines[0], ctx.sourcePath);
    if (!file) return this.showError(el, "file not found: " + lines[0]);
    const auto = hArg === "auto";
    const height = auto ? 400 : parseInt(hArg, 10) || 600;

    let html;
    try { html = await this.app.vault.read(file); }
    catch (err) { return this.showError(el, "could not read " + file.path + " (" + err.message + ")"); }

    const base = this.app.vault.getResourcePath(file).split("?")[0].replace(/[^/]*$/, "");
    const token = Math.random().toString(36).slice(2);
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
    if (tail) html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, tail + "</body>") : html + tail;

    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const wrap = el.createDiv({ cls: "html-embed-anywhere" });
    const iframe = wrap.createEl("iframe", { attr: { src: url, sandbox: LOCAL_SANDBOX, title: file.name } });
    iframe.style.height = height + "px";
    const cap = wrap.createDiv({ cls: "html-embed-anywhere-caption", text: file.name });
    cap.setAttr("title", "Open " + file.path + " in the default browser");
    cap.addEventListener("click", () => { if (this.app.openWithDefaultApp) this.app.openWithDefaultApp(file.path); });
    const child = new HtmlFrame(wrap, url);
    if (auto) { this.frames.set(token, iframe); child.register(() => this.frames.delete(token)); }
    ctx.addChild(child);
    this.fitToCanvasCard(wrap, iframe, cap, child);
  }

  renderUrl(url, hArg, el, ctx) {
    const height = parseInt(hArg, 10) || parseInt(this.settings.defaultHeight, 10) || 600;
    const wrap = el.createDiv({ cls: "html-embed-anywhere is-web" });
    const iframe = wrap.createEl("iframe", {
      attr: { src: url, sandbox: WEB_SANDBOX, allow: "fullscreen; clipboard-write; encrypted-media; picture-in-picture", title: url },
    });
    iframe.style.height = height + "px";
    const cap = wrap.createEl("a", { cls: "html-embed-anywhere-caption external-link", text: shortUrl(url), href: url });
    cap.setAttr("title", "Open in browser — if the frame stays blank, this site does not allow embedding");
    const child = new MarkdownRenderChild(wrap);
    ctx.addChild(child);
    this.fitToCanvasCard(wrap, iframe, cap, child);
  }

  // In a canvas card the frame fills the card (resizing the card resizes the embed) and stays inert,
  // so the card handles, connection points and dragging work like any other card. Select the card
  // and press "Interact" to use the embedded page; it switches off again when the card is deselected.
  fitToCanvasCard(wrap, iframe, cap, child, tries = 0) {
    const card = wrap.closest(".canvas-node-content");
    if (!card) {
      if (!wrap.isConnected && tries < 30) window.requestAnimationFrame(() => this.fitToCanvasCard(wrap, iframe, cap, child, tries + 1));
      return;
    }
    wrap.addClass("is-in-canvas");
    this.frames.forEach((fr, t) => { if (fr === iframe) this.frames.delete(t); }); // card size wins over "auto"

    // caption row + Interact toggle
    const bar = createDiv({ cls: "html-embed-anywhere-bar" });
    cap.replaceWith(bar);
    bar.appendChild(cap);
    const btn = bar.createEl("button", { cls: "html-embed-anywhere-interact clickable-icon", attr: { "aria-label": "Interact with the embedded page" } });
    setIcon(btn, "mouse-pointer-click");
    btn.createSpan({ text: "Interact" });
    const setInteractive = (on) => {
      wrap.toggleClass("is-interactive", on);
      btn.toggleClass("is-active", on);
      btn.lastChild.textContent = on ? "Done" : "Interact";
    };
    btn.addEventListener("click", (e) => { e.stopPropagation(); setInteractive(!wrap.hasClass("is-interactive")); });
    const node = wrap.closest(".canvas-node");
    if (node) {
      const mo = new MutationObserver(() => { if (!node.hasClass("is-focused")) setInteractive(false); });
      mo.observe(node, { attributes: true, attributeFilter: ["class"] });
      child.register(() => mo.disconnect());
    }

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
};

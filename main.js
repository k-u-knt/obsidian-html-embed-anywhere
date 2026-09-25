/* HTML Embed Anywhere — embed vault-local HTML (Plotly, D3, reports) in notes and canvas.
 * Works on macOS and iOS/iPadOS.
 *
 * Ways to embed:
 *   • Command palette → "Embed HTML file…"  (note: inserts a block at the cursor; canvas: adds a card)
 *   • Drag an .html file from Finder or from Obsidian's file list into a note or canvas
 *     (files from Finder are first copied into your attachment folder)
 *   • Right-click / long-press an .html file → "Embed in current note" / "Copy embed code"
 *
 * The block it writes:
 *   ```html-embed
 *   path/to/file.html      (vault path, bare file name or [[link]])
 *   600                    (optional: height in px, or "auto")
 *   ```
 * The file is read through the vault API and loaded into a sandboxed iframe as a blob, so it
 * does not rely on Obsidian's blocked local-file URLs. Scripts run, but the frame gets an opaque
 * origin (no allow-same-origin): embedded code cannot reach Obsidian or the vault.
 */
const {
  Plugin, MarkdownRenderChild, MarkdownView, TFile, normalizePath,
  FuzzySuggestModal, Notice, PluginSettingTab, Setting,
} = require("obsidian");

const DEFAULTS = { defaultHeight: "600", canvasWidth: 820 };
const isHtml = (f) => f instanceof TFile && /^html?$/i.test(f.extension);
const isHtmlName = (n) => /\.html?$/i.test(n || "");

class HtmlFrame extends MarkdownRenderChild {
  constructor(el, url) { super(el); this.url = url; }
  onunload() { if (this.url) URL.revokeObjectURL(this.url); }
}

class HtmlPicker extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Pick an HTML file to embed (most recent first)…");
  }
  getItems() {
    return this.app.vault.getFiles().filter(isHtml).sort((a, b) => b.stat.mtime - a.stat.mtime);
  }
  getItemText(f) { return f.path; }
  onChooseItem(f) { this.onChoose(f); }
}

class HtmlEmbedSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Default height")
      .setDesc('Height written into new embeds: a number of pixels, or "auto" to fit the content.')
      .addText((t) => t.setValue(this.plugin.settings.defaultHeight).onChange(async (v) => {
        this.plugin.settings.defaultHeight = v.trim() || "600";
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("Canvas card width")
      .setDesc("Width in pixels of cards created on a canvas.")
      .addText((t) => t.setValue(String(this.plugin.settings.canvasWidth)).onChange(async (v) => {
        this.plugin.settings.canvasWidth = parseInt(v, 10) || 820;
        await this.plugin.saveSettings();
      }));
  }
}

module.exports = class HtmlEmbedAnywhere extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.addSettingTab(new HtmlEmbedSettings(this.app, this));

    // ---- rendering ----
    this.frames = new Map(); // token -> iframe (auto height)
    this.registerDomEvent(window, "message", (e) => {
      const d = e.data;
      if (!d || typeof d !== "object" || !d.__htmlEmbedAnywhere) return;
      const fr = this.frames.get(d.__htmlEmbedAnywhere);
      if (fr && e.source === fr.contentWindow && d.h > 0) fr.style.height = Math.min(Math.max(d.h, 50), 4000) + "px";
    });
    this.registerMarkdownCodeBlockProcessor("html-embed", (src, el, ctx) => this.render(src, el, ctx));

    // ---- command ----
    this.addCommand({
      id: "embed-html-file",
      name: "Embed HTML file…",
      icon: "file-code",
      callback: () => new HtmlPicker(this.app, (f) => this.embedIntoActiveView(f)).open(),
    });
    this.addRibbonIcon("file-code", "Embed HTML file", () =>
      new HtmlPicker(this.app, (f) => this.embedIntoActiveView(f)).open());

    // ---- right-click / long-press on an .html file ----
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!isHtml(file)) return;
      menu.addItem((i) => i.setTitle("Embed in current note / canvas").setIcon("file-code")
        .onClick(() => this.embedIntoActiveView(file)));
      menu.addItem((i) => i.setTitle("Copy HTML embed code").setIcon("copy")
        .onClick(async () => { await navigator.clipboard.writeText(this.block(file)); new Notice("HTML embed code copied"); }));
    }));

    // ---- drag & drop into a note ----
    this.registerEvent(this.app.workspace.on("editor-drop", (evt, editor, info) => {
      if (evt.defaultPrevented) return;
      const internal = this.draggedVaultHtml();
      const external = this.droppedExternalHtml(evt);
      if (!internal.length && !external.length) return;
      evt.preventDefault();
      this.moveCursorToDrop(editor, evt);
      (async () => {
        const files = internal.length ? internal : await this.importExternal(external, info?.file?.path || "");
        for (const f of files) this.insertBlock(editor, f);
      })();
    }));

    // ---- drag from Obsidian's file list into a note (Obsidian handles these before editor-drop) ----
    this.registerDomEvent(document, "drop", (evt) => {
      const internal = this.draggedVaultHtml();
      if (!internal.length) return;
      const leaf = this.app.workspace.getLeavesOfType("markdown").find((l) => l.view.editor && l.view.contentEl.contains(evt.target));
      if (!leaf || (leaf.view.getMode && leaf.view.getMode() === "preview")) return;
      evt.preventDefault();
      evt.stopPropagation();
      const editor = leaf.view.editor;
      this.moveCursorToDrop(editor, evt);
      for (const f of internal) this.insertBlock(editor, f);
      if (this.app.dragManager) this.app.dragManager.draggable = null;
    }, { capture: true });

    // ---- drag & drop onto a canvas ----
    this.registerDomEvent(document, "drop", (evt) => {
      const leaf = this.app.workspace.getLeavesOfType("canvas").find((l) => l.view.containerEl.contains(evt.target));
      if (!leaf || !leaf.view.canvas) return;
      if (evt.target.closest && evt.target.closest(".canvas-node-content .cm-editor")) return; // dropping into a card being edited
      const internal = this.draggedVaultHtml();
      const external = this.droppedExternalHtml(evt);
      if (!internal.length && !external.length) return;
      evt.preventDefault();
      evt.stopPropagation();
      const canvas = leaf.view.canvas;
      const pos = canvas.posFromEvt ? canvas.posFromEvt(evt) : null;
      (async () => {
        const files = internal.length ? internal : await this.importExternal(external, leaf.view.file?.path || "");
        files.forEach((f, i) => this.addCanvasCard(canvas, f, pos && { x: pos.x + i * 40, y: pos.y + i * 40 }));
      })();
      if (internal.length && this.app.dragManager) this.app.dragManager.draggable = null;
    }, { capture: true });
  }

  async saveSettings() { await this.saveData(this.settings); }

  // ---------- helpers: building / inserting ----------
  block(file, height) {
    return "```html-embed\n" + file.path + "\n" + (height || this.settings.defaultHeight) + "\n```\n";
  }

  insertBlock(editor, file) {
    // Put the block on its own lines, separated from neighbouring text by blank lines.
    const ln = editor.getCursor().line;
    const line = editor.getLine(ln);
    const blk = this.block(file).replace(/\n$/, "");
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

  moveCursorToDrop(editor, evt) {
    try {
      const cm = editor.cm;
      const off = cm && cm.posAtCoords({ x: evt.clientX, y: evt.clientY });
      if (off != null) editor.setCursor(editor.offsetToPos(off));
    } catch (_) { /* keep current cursor */ }
  }

  addCanvasCard(canvas, file, pos) {
    const h = parseInt(this.settings.defaultHeight, 10) || 600;
    const w = this.settings.canvasWidth || 820;
    const at = pos || (canvas.getViewportBBox ? (() => { const b = canvas.getViewportBBox(); return { x: (b.minX + b.maxX) / 2 - w / 2, y: (b.minY + b.maxY) / 2 - h / 2 }; })() : { x: 0, y: 0 });
    const text = this.block(file, String(h));
    try {
      canvas.createTextNode({ pos: at, size: { width: w, height: h + 40 }, text, focus: false, save: true });
      canvas.requestSave && canvas.requestSave();
    } catch (e) {
      navigator.clipboard.writeText(text);
      new Notice("Could not add a canvas card automatically — embed code copied; paste it into a card.");
    }
  }

  embedIntoActiveView(file) {
    const leaf = this.app.workspace.getMostRecentLeaf ? this.app.workspace.getMostRecentLeaf() : this.app.workspace.activeLeaf;
    const view = leaf && leaf.view;
    if (view && view.getViewType && view.getViewType() === "canvas" && view.canvas) return this.addCanvasCard(view.canvas, file);
    if (view instanceof MarkdownView) {
      if (view.getMode && view.getMode() === "preview") { new Notice("Switch the note to editing mode to insert."); return; }
      return this.insertBlock(view.editor, file);
    }
    navigator.clipboard.writeText(this.block(file));
    new Notice("No note or canvas open — embed code copied to clipboard.");
  }

  // ---------- helpers: drag sources ----------
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
    const out = [];
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        const path = await this.app.fileManager.getAvailablePathForAttachment(f.name, sourcePath);
        out.push(await this.app.vault.createBinary(path, buf));
      } catch (e) { new Notice("Could not import " + f.name + ": " + e.message); }
    }
    if (out.length) new Notice("Imported " + out.map((f) => f.path).join(", "));
    return out;
  }

  // ---------- rendering ----------
  showError(el, msg) {
    el.createDiv({ cls: "html-embed-anywhere-error", text: "html-embed: " + msg });
  }

  resolve(raw, sourcePath) {
    const p = raw.trim().replace(/^!?\[\[/, "").replace(/\]\]$/, "").replace(/\|.*$/, "").replace(/^<|>$/g, "");
    const direct = this.app.vault.getAbstractFileByPath(normalizePath(p));
    if (direct instanceof TFile) return direct;
    const viaLink = this.app.metadataCache.getFirstLinkpathDest(p, sourcePath);
    return viaLink instanceof TFile ? viaLink : null;
  }

  async render(src, el, ctx) {
    const lines = src.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return this.showError(el, "add a file path on the first line");
    const file = this.resolve(lines[0], ctx.sourcePath);
    if (!file) return this.showError(el, "file not found: " + lines[0]);
    const hArg = (lines[1] || this.settings.defaultHeight || "600").toLowerCase();
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
    const iframe = wrap.createEl("iframe", {
      attr: { src: url, sandbox: "allow-scripts allow-popups allow-forms allow-downloads allow-modals", title: file.name },
    });
    iframe.style.height = height + "px";
    const cap = wrap.createDiv({ cls: "html-embed-anywhere-caption", text: file.name });
    cap.setAttr("title", "Open " + file.path + " in the default browser");
    cap.addEventListener("click", () => { if (this.app.openWithDefaultApp) this.app.openWithDefaultApp(file.path); });
    const child = new HtmlFrame(wrap, url);
    if (auto) { this.frames.set(token, iframe); child.register(() => this.frames.delete(token)); }
    ctx.addChild(child);
    this.fitToCanvasCard(wrap, iframe, cap, child);
  }

  // In a canvas card the frame fills the card, so resizing the card resizes the embed.
  fitToCanvasCard(wrap, iframe, cap, child, tries = 0) {
    const card = wrap.closest(".canvas-node-content");
    if (!card) {
      if (!wrap.isConnected && tries < 30) window.requestAnimationFrame(() => this.fitToCanvasCard(wrap, iframe, cap, child, tries + 1));
      return;
    }
    wrap.addClass("is-in-canvas");
    this.frames.forEach((fr, t) => { if (fr === iframe) this.frames.delete(t); }); // card size wins over "auto"
    const fit = () => {
      if (!card.clientHeight) return;
      const cr = card.getBoundingClientRect();
      const scale = cr.height / card.clientHeight || 1; // canvas zoom
      const top = (iframe.getBoundingClientRect().top - cr.top) / scale;
      const h = Math.floor(card.clientHeight - top - cap.offsetHeight - 16);
      if (h > 40) iframe.style.height = h + "px";
    };
    const ro = new ResizeObserver(() => fit());
    ro.observe(card);
    child.register(() => ro.disconnect());
    fit();
  }
};

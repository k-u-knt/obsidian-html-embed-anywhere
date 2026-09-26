# HTML Embed Anywhere

Embed **local HTML files from your vault** — interactive Plotly or D3 figures, HTML reports, small dashboards — and **web pages** directly inside Obsidian notes and canvas cards, with their JavaScript working. Runs on **desktop and on iOS/iPadOS**.

Obsidian does not load vault-local `.html` files in an `<iframe>` (a deliberate security restriction), and it cannot render `.html` files placed on a canvas. This plugin reads the file through the vault API and shows it in a sandboxed frame instead.

## Usage

An embed is a code block:

````markdown
```html-embed
figures/umap_by_age.html
600
```
````

- **Line 1**: the file — a vault path, a bare file name, or a `[[link]]` — or a web page URL (`https://…`).
- **Line 2** (optional): height in pixels, or `auto` to fit the content. Defaults to the value in settings (600).
- **`size WxH`** (optional, e.g. `size 900x500`): fixes the embed at that size instead of following the note width or card size. On a canvas the *Fit card / Fixed* button writes this line for you.

A single Plotly figure inside the file is resized to fill the embed, so it follows the note width, the canvas card size, or the fixed size.

You rarely need to type it:

| How | Where | What it does |
|---|---|---|
| Command palette → **Embed HTML file…** (also the `</>` ribbon icon) | Desktop, mobile | Search the vault's `.html` files (newest first). In a note it inserts the block at the cursor; in a canvas it adds a card. |
| Command palette → **Embed web page…** | Desktop, mobile | Paste a URL to embed it. |
| **Drag an `.html` file** from Finder / Explorer or from Obsidian's file list into a note or canvas | Desktop | Asks whether to **Embed** or **Insert link**. Files from Finder / Explorer are first copied into the vault (see *Import folder*), so the vault stays self-contained. |
| **Drag a web link** from a browser into a note or canvas | Desktop | Asks whether to **Embed** the page or **Insert link** (`[Page title](url)`). |
| **Right-click / long-press** an `.html` file | Desktop, mobile | *Embed in current note / canvas* or *Copy HTML embed code*. |

### The drop dialog

When you drop an HTML file or a web link, a dialog asks what to do:

- **Embed** — note: an `html-embed` block at the drop point; canvas: a live card (web pages use Obsidian's own web card).
- **Insert link** — note: a link in your usual link format (`[[file.html]]` or `[Title](https://…)`); canvas: a file card or a text card with the link. Files dropped from outside the vault are imported first in both cases, so links always point inside the vault.
- **Cancel** — nothing is inserted.

Tick **Remember my choice** to skip the dialog next time. Both behaviours (files and web links) can be set in *Settings → HTML Embed Anywhere → Drag and drop*: *Ask each time*, *Always embed*, *Always insert a link* — and for web links also *Don't handle*, which leaves drops to Obsidian. Dropping other kinds of files, or a mix, is left to Obsidian as usual.

Click the caption under an embed to open the file or page in your default browser. Some websites forbid being shown inside other apps; those embeds stay blank — use the caption link or *Insert link* instead.

### Canvas

Canvas cards containing an `html-embed` block render the HTML live, and the embed fills the card, so resizing the card resizes the figure. The plugin creates those cards for you from the command or a drop.

Select a card to show its two controls under the embed:

| Control | States |
|---|---|
| **Size** | **Fit card** (default) — the embed, and a Plotly figure in it, follows the card as you resize it. **Fixed W×H** — click to freeze the current size; resizing the card no longer changes the plot (a smaller card scrolls). Click again to go back to *Fit card*. The fixed size is saved in the card (`size WxH`). |
| **Lock** | **Locked** (default) — the embed is a static picture: no hover labels or tooltips, and the card can be dragged, resized and connected like any other card. **Interacting** — hover values, zoom, pan, select. It locks again when you click another card or the empty canvas. |

### Plotly tip

`fig.write_html("plot.html")` embeds the whole plotly.js library (~4 MB) so the figure works offline. `include_plotlyjs="cdn"` makes much smaller files but needs internet access to display.

## Settings

- **Default height** — written into new embeds (pixels or `auto`).
- **Canvas card width** — width of cards created on a canvas.
- **Import folder** — where HTML files dropped from outside the vault are copied. Empty = Obsidian's attachment setting (*Files and links → Default location for new attachments*).
- **Reuse identical files** (on by default) — applies to **every file you drop or paste from outside the vault** (HTML, images, PDFs, data …). Before importing, the plugin checks whether a file with **exactly the same content** already exists anywhere in the vault, whatever its name or folder; if so the new embed/link points to that file instead of creating `name 1.png`, `name 2.png`, …. You can drop the same file many times — each drop gets its own embed, all pointing to one file. Non-HTML files are otherwise handled like Obsidian does: imported into the attachment folder and embedded (`![[…]]` in notes, a file card on canvas); pasted screenshots are named `Pasted image <timestamp>.png`. The check is cheap: only files with the identical byte size (known from the vault index, no disk reads) are candidates, and those are compared by SHA-256, with hashes cached. Turn it off to leave non-HTML drops and pastes entirely to Obsidian.
- **When an HTML file is dropped** — ask / always embed / always insert a link.
- **When a web link is dropped** — ask / always embed / always insert a link / don't handle.

## Security

Only embed HTML you trust. Scripts inside a local file **do run**, but the frame is sandboxed **without** `allow-same-origin`, so the embedded page gets an opaque origin and cannot access Obsidian, your vault, or other notes. Relative resources (images, local `.js`) are resolved next to the HTML file.

Embedded web pages run under their own website's origin (as in a browser tab), which is separate from Obsidian's, so they cannot read your vault either.

### Opening .html files

The plugin registers `.html` / `.htm` as a file type, so HTML files are **always listed in the file explorer** (no need for *Detect all file extensions*) and **open rendered in their own Obsidian tab** when you click them or follow a link. Use the tab's *Open in default browser* button to open them outside Obsidian. (If another plugin already handles `.html`, that one keeps it.)

### Canvas position fix

Obsidian's canvas caches where it sits on screen and only refreshes that when it is resized. If the canvas tab moves without resizing — typically in a **stacked tab group** — the cache goes stale: zooming centres on the wrong spot, hovering no longer finds cards (no resize handles or connection points), and dropped items land away from the cursor. While this plugin is enabled it checks the cache against the canvas's real position before the canvas handles pointer, wheel and drop events, and refreshes it when it has moved. This fixes those symptoms for every canvas, not only HTML embeds.

## Limitations

- Drag-and-drop from the file list, the drop dialog's canvas actions and canvas card creation use undocumented Obsidian internals (`dragManager`, canvas API). They may need updating after Obsidian releases; the core `html-embed` rendering uses only the public API.
- Very large files are read into memory each time the note renders.
- `auto` height measures the page's content; pages that size themselves to the viewport (e.g. `height: 100vh`) should use a fixed height.

## Installation

**With BRAT:** install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then *Add beta plugin* → `k-u-knt/obsidian-html-embed-anywhere`.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/k-u-knt/obsidian-html-embed-anywhere/releases/latest) into `<vault>/.obsidian/plugins/html-embed-anywhere/`, then enable *HTML Embed Anywhere* in *Settings → Community plugins*. On iOS/iPadOS, a vault synced with iCloud or Obsidian Sync picks the plugin up from the synced folder.

## License

[MIT](LICENSE) © Kenta Ninomiya

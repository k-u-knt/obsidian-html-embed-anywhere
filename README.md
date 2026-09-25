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

The embed stays **inert** on the canvas, so the card behaves like any other card: drag it, resize it from its edges, and draw connections from it. To use the embedded page (hover, zoom, pan), **select the card and press _Interact_** under it; press **Done** — or just click elsewhere on the canvas — to go back.

### Plotly tip

`fig.write_html("plot.html")` embeds the whole plotly.js library (~4 MB) so the figure works offline. `include_plotlyjs="cdn"` makes much smaller files but needs internet access to display.

## Settings

- **Default height** — written into new embeds (pixels or `auto`).
- **Canvas card width** — width of cards created on a canvas.
- **Import folder** — where HTML files dropped from outside the vault are copied. Empty = Obsidian's attachment setting (*Files and links → Default location for new attachments*). If an identical file is already there it is reused instead of making `name 1.html`, `name 2.html`, ….
- **When an HTML file is dropped** — ask / always embed / always insert a link.
- **When a web link is dropped** — ask / always embed / always insert a link / don't handle.

## Security

Only embed HTML you trust. Scripts inside a local file **do run**, but the frame is sandboxed **without** `allow-same-origin`, so the embedded page gets an opaque origin and cannot access Obsidian, your vault, or other notes. Relative resources (images, local `.js`) are resolved next to the HTML file.

Embedded web pages run under their own website's origin (as in a browser tab), which is separate from Obsidian's, so they cannot read your vault either.

## Limitations

- Drag-and-drop from the file list, the drop dialog's canvas actions and canvas card creation use undocumented Obsidian internals (`dragManager`, canvas API). They may need updating after Obsidian releases; the core `html-embed` rendering uses only the public API.
- Very large files are read into memory each time the note renders.
- `auto` height measures the page's content; pages that size themselves to the viewport (e.g. `height: 100vh`) should use a fixed height.

## Installation

**With BRAT:** install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then *Add beta plugin* → `k-u-knt/obsidian-html-embed-anywhere`.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/k-u-knt/obsidian-html-embed-anywhere/releases/latest) into `<vault>/.obsidian/plugins/html-embed-anywhere/`, then enable *HTML Embed Anywhere* in *Settings → Community plugins*. On iOS/iPadOS, a vault synced with iCloud or Obsidian Sync picks the plugin up from the synced folder.

## License

[MIT](LICENSE) © Kenta Ninomiya

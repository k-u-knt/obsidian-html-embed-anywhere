# HTML Embed Anywhere

Embed **local HTML files from your vault** — interactive Plotly or D3 figures, HTML reports, small dashboards — directly inside Obsidian notes and canvas cards, with their JavaScript working. Runs on **desktop and on iOS/iPadOS**.

Obsidian does not load vault-local `.html` files in an `<iframe>` (a deliberate security restriction), and it cannot render `.html` files placed on a canvas. This plugin reads the file through the vault API and shows it in a sandboxed frame instead.

## Usage

An embed is a code block:

````markdown
```html-embed
figures/umap_by_age.html
600
```
````

- **Line 1**: the file — a vault path, a bare file name, or a `[[link]]`.
- **Line 2** (optional): height in pixels, or `auto` to fit the content. Defaults to the value in settings (600).

You rarely need to type it:

| How | Where | What it does |
|---|---|---|
| Command palette → **Embed HTML file…** (also the `</>` ribbon icon) | Desktop, mobile | Search the vault's `.html` files (newest first). In a note it inserts the block at the cursor; in a canvas it adds a card. |
| **Drag an `.html` file from Finder / Explorer** into a note or canvas | Desktop | Copies it into your attachment folder (*Settings → Files and links*) and embeds it at the drop point. |
| **Drag an `.html` file from Obsidian's file list** into a note or canvas | Desktop | Embeds it where you drop it. |
| **Right-click / long-press** an `.html` file | Desktop, mobile | *Embed in current note / canvas* or *Copy HTML embed code*. |

Click the file name under an embed to open the file in your default browser.

### Canvas

Canvas cards containing an `html-embed` block render the HTML live, and the embed fills the card, so resizing the card resizes the figure. The plugin creates those cards for you from the command or a drop.

While a card is not selected, the embed ignores the mouse so the canvas can show resize handles and connection points and you can drag the card. **Click a card once** to interact with the embedded page (hover, zoom, pan); click the empty canvas to release it.

### Plotly tip

`fig.write_html("plot.html")` embeds the whole plotly.js library (~4 MB) so the figure works offline. `include_plotlyjs="cdn"` makes much smaller files but needs internet access to display.

## Settings

- **Default height** — written into new embeds (pixels or `auto`).
- **Canvas card width** — width of cards created on a canvas.

## Security

Only embed HTML you trust. Scripts inside the file **do run**, but the frame is sandboxed **without** `allow-same-origin`, so the embedded page gets an opaque origin and cannot access Obsidian, your vault, or other notes. Relative resources (images, local `.js`) are resolved next to the HTML file.

## Limitations

- Drag-and-drop from the file list and canvas card creation use undocumented Obsidian internals (`dragManager`, canvas API). They may need updating after Obsidian releases; the core `html-embed` rendering uses only the public API.
- Very large files are read into memory each time the note renders.
- `auto` height measures the page's content; pages that size themselves to the viewport (e.g. `height: 100vh`) should use a fixed height.

## Installation

**With BRAT:** install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then *Add beta plugin* → `k-u-knt/obsidian-html-embed-anywhere`.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/k-u-knt/obsidian-html-embed-anywhere/releases/latest) into `<vault>/.obsidian/plugins/html-embed-anywhere/`, then enable *HTML Embed Anywhere* in *Settings → Community plugins*. On iOS/iPadOS, a vault synced with iCloud or Obsidian Sync picks the plugin up from the synced folder.

## License

[MIT](LICENSE) © Kenta Ninomiya

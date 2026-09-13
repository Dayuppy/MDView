# Third-party notices

`out\MDView(.debug).exe` embeds the libraries below (`assets/vendor/`, `sdk/`) as resources.
This file lists what's bundled and under what license; it does not reproduce full license
text — see each project's own repository for that.

## Bundled in `assets/vendor/` (all permissive open-source licenses)

| Library | Version | License | Used for |
| --- | --- | --- | --- |
| [markdown-it](https://github.com/markdown-it/markdown-it) | 14 | MIT | CommonMark/GFM rendering |
| markdown-it-abbr | — | MIT | Abbreviation (`*[HTML]: ...`) syntax |
| markdown-it-anchor | — | MIT | Heading anchors |
| markdown-it-deflist | — | MIT | Definition lists |
| markdown-it-emoji | — | MIT | `:emoji:` shortcodes |
| markdown-it-footnote | — | MIT | Footnotes |
| markdown-it-ins | — | MIT | `++inserted++` text |
| markdown-it-mark | — | MIT | `==highlighted==` text |
| markdown-it-sub / -sup | — | MIT | Sub/superscript |
| markdown-it-task-lists | — | MIT | `- [ ]` task lists |
| [texmath](https://github.com/goessner/markdown-it-texmath) | — | MIT | `$…$`/`$$…$$` math delimiters |
| [KaTeX](https://github.com/KaTeX/KaTeX) (+ fonts, mhchem contrib) | 0.16 | MIT | Math typesetting |
| [highlight.js](https://github.com/highlightjs/highlight.js) (+ language packs) | 11 | BSD-3-Clause | Fenced-code syntax highlighting |
| [Mermaid](https://github.com/mermaid-js/mermaid) | 11 | MIT | Diagrams |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3 | Apache-2.0 OR MIT | HTML sanitization |
| [Turndown](https://github.com/mixmark-io/turndown) + turndown-plugin-gfm | — | MIT | Paste: HTML → Markdown |

## Bundled in `sdk/`

| Component | License |
| --- | --- |
| Microsoft Edge WebView2 SDK (1.0.4129.50) — header + static loader | [Microsoft Software License Terms](https://www.nuget.org/packages/Microsoft.Web.WebView2) (redistributable as part of an application; not open source) |

Rendering itself uses the Windows-provided WebView2 (Chromium) runtime, which this app does not
bundle — it's a system component, installed separately by Windows or the WebView2 Runtime
installer.

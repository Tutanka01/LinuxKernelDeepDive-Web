# Vendored libraries

Three third-party libraries, served from this directory instead of a CDN.

The site is otherwise one self-contained tree of plain files: it renders with
no build step, no package manager and no network beyond its own origin. The
three cdnjs `<script>` tags were the exception, and they carried neither
`integrity` nor `crossorigin` — whatever cdnjs returned was executed
unverified. Hosting the files removes both the trust problem and the
third-party request.

Nothing here is modified. Each file is byte-for-byte what the upstream URL
served on the date below.

| file | upstream | version | pinned |
|---|---|---|---|
| `marked.min.js` | `https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js` | 12.0.2 | 2026-07-27 |
| `highlight.min.js` | `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js` | 11.9.0 | 2026-07-27 |
| `mermaid.min.js` | `https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js` | 10.9.1 | 2026-07-27 |
| `hljs/gruvbox-dark-medium.min.css` | `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/base16/gruvbox-dark-medium.min.css` | 11.9.0 | 2026-07-27 |
| `hljs/gruvbox-light-medium.min.css` | `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/base16/gruvbox-light-medium.min.css` | 11.9.0 | 2026-07-27 |

SHA-256, so a later re-fetch can be checked against what is committed here:

```
15fabce5b65898b32b03f5ed25e9f891a729ad4c0d6d877110a7744aa847a894   35479  marked.min.js
837a6fa5b0c736b52bbde2b2b6190f305da3fc9ed41681db5321507057b5c846  121727  highlight.min.js
61b335a46df05a7ce1c98378f60e5f3e77a7fb608a1056997e8a649304a936d6 3335717  mermaid.min.js
007f6c95f9a9e9148e589b9f654bde9413703bcc7bd1ddd6a02855ee1e082dbb    1451  hljs/gruvbox-dark-medium.min.css
c71a82079175866e1b50bf4226fb90594060bdfe70e48193fe1fbfc86f66b015    1452  hljs/gruvbox-light-medium.min.css
```

Verify:

```sh
cd assets/vendor
shasum -a 256 marked.min.js highlight.min.js mermaid.min.js hljs/*.css
```

Re-fetch (same command that produced these files):

```sh
curl -fsSL -o marked.min.js    https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js
curl -fsSL -o highlight.min.js https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js
curl -fsSL -o mermaid.min.js   https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js
curl -fsSL -o hljs/gruvbox-dark-medium.min.css  https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/base16/gruvbox-dark-medium.min.css
curl -fsSL -o hljs/gruvbox-light-medium.min.css https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/base16/gruvbox-light-medium.min.css
```

## Who loads what, and when

`marked.min.js` and `highlight.min.js` are `<script>` tags in all three
shells. They are small, and every chapter needs both.

`mermaid.min.js` is not in any shell. At 3.2 MB it dwarfs the rest of the
site put together, and it used to be downloaded on every page view of the
Linux course — including the six chapters with no diagram and the course
home, which has none. `assets/reader-ui.js` now injects it on demand, the
first time a rendered chapter actually contains a `pre.mermaid`, and caches
the promise so it is fetched at most once per session.

The bundle is self-contained: it declares no dynamic `import()`, ships no
`sourceMappingURL`, and the only external file names in it (`./elk-api.js`,
`./elk-worker.min.js`) belong to the optional ELK layout engine, which
Mermaid touches only for `flowchart-elk` diagrams. No chapter uses one.

Paths are resolved by `ReaderUI.vendorUrl()` against `reader-ui.js`'s own
script URL, not against the document: the three shells sit at two different
directory depths, so a path relative to the document would be wrong for two
of the three courses.

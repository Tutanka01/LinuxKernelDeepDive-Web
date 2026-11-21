# Vendored libraries and fonts

Three third-party libraries and two typefaces, served from this directory
instead of a CDN, plus the site's own two highlight.js themes.

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
| `fonts/AtkinsonHyperlegibleNext-wght.woff2` | `https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/7925f50f649b3813257faf2f4c0b381011f434f1/fonts/webfonts/AtkinsonHyperlegibleNext%5Bwght%5D.woff2` | font revision 2.66, variable wght 200–800 | 2026-11-21 |
| `fonts/AtkinsonHyperlegibleNext-Italic-wght.woff2` | `https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/7925f50f649b3813257faf2f4c0b381011f434f1/fonts/webfonts/AtkinsonHyperlegibleNext-Italic%5Bwght%5D.woff2` | font revision 2.66, variable wght 200–800 | 2026-11-21 |
| `fonts/OFL-AtkinsonHyperlegibleNext.txt` | `https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/7925f50f649b3813257faf2f4c0b381011f434f1/OFL.txt` | — | 2026-11-21 |
| `fonts/JetBrainsMono-wght.woff2` | `https://raw.githubusercontent.com/JetBrains/JetBrainsMono/19371302b95d218af43299bce79ddbddd0bc364d/fonts/webfonts/JetBrainsMono%5Bwght%5D.woff2` | font revision 2.2, variable wght 100–800 | 2026-11-21 |
| `fonts/OFL-JetBrainsMono.txt` | `https://raw.githubusercontent.com/JetBrains/JetBrainsMono/19371302b95d218af43299bce79ddbddd0bc364d/OFL.txt` | — | 2026-11-21 |

Both typefaces are under the SIL Open Font License 1.1; the licence text
travels with them in `fonts/`. The files are renamed only (the upstream
`[wght]` brackets would have to be escaped in every `url()`); their bytes
are untouched. `@font-face` rules live at the top of `assets/style.css`,
with `font-display: swap`.

`hljs/ldd-dark.css` and `hljs/ldd-paper.css` are not vendored: they are the
site's own highlight.js themes, written from the same palette as
`assets/style.css` (every token colour clears 4.5:1 on the code ground).
They replaced the gruvbox base16 themes in 2026-11.

SHA-256, so a later re-fetch can be checked against what is committed here:

```
15fabce5b65898b32b03f5ed25e9f891a729ad4c0d6d877110a7744aa847a894   35479  marked.min.js
837a6fa5b0c736b52bbde2b2b6190f305da3fc9ed41681db5321507057b5c846  121727  highlight.min.js
61b335a46df05a7ce1c98378f60e5f3e77a7fb608a1056997e8a649304a936d6 3335717  mermaid.min.js
abde1ad5cf78b9ac575ef90d991f2e9101eb0b3b6668bde9a00e2e1e27d99afd   48188  fonts/AtkinsonHyperlegibleNext-wght.woff2
34491c5a87f711d314637962f69267d28c7df3ed498082c990cdfbbc02ebf3f2   52692  fonts/AtkinsonHyperlegibleNext-Italic-wght.woff2
31ec365b93e4bad6f202ce23352a56d01ca4462b2afc782ed2cf6fa42ca9ac0e  113672  fonts/JetBrainsMono-wght.woff2
aca6a428580965d2297d1b718042dd427c2a9443ece3b0d02d758e161e0c4030    4431  fonts/OFL-AtkinsonHyperlegibleNext.txt
a76abf002c49097d146e86740a3105a5d00450b1592e820a1109a8c5680cd697    4399  fonts/OFL-JetBrainsMono.txt
```

Verify:

```sh
cd assets/vendor
shasum -a 256 marked.min.js highlight.min.js mermaid.min.js fonts/*
```

Re-fetch (same command that produced these files):

```sh
curl -fsSL -o marked.min.js    https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js
curl -fsSL -o highlight.min.js https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js
curl -fsSL -o mermaid.min.js   https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js
A=https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/7925f50f649b3813257faf2f4c0b381011f434f1
J=https://raw.githubusercontent.com/JetBrains/JetBrainsMono/19371302b95d218af43299bce79ddbddd0bc364d
curl -fsSL -o fonts/AtkinsonHyperlegibleNext-wght.woff2        "$A/fonts/webfonts/AtkinsonHyperlegibleNext%5Bwght%5D.woff2"
curl -fsSL -o fonts/AtkinsonHyperlegibleNext-Italic-wght.woff2 "$A/fonts/webfonts/AtkinsonHyperlegibleNext-Italic%5Bwght%5D.woff2"
curl -fsSL -o fonts/OFL-AtkinsonHyperlegibleNext.txt           "$A/OFL.txt"
curl -fsSL -o fonts/JetBrainsMono-wght.woff2                   "$J/fonts/webfonts/JetBrainsMono%5Bwght%5D.woff2"
curl -fsSL -o fonts/OFL-JetBrainsMono.txt                      "$J/OFL.txt"
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

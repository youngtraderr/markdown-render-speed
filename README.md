# markdown-render-speed

A dependency-free ES module that renders Markdown to the exact HTML
[marked](https://github.com/markedjs/marked) 18.1.3 produces with its default
options (GFM on, `breaks` off, `pedantic` off, `async` off).

## What it is

`parse.js` exports `parse(markdown)`, a single function returning the HTML
string for that Markdown, byte for byte identical to `marked.parse(markdown)`.
It is an original implementation — no vendored parser, no dependencies, no
Node built-ins — built as a line-oriented block scanner plus an inline scanner
with a CommonMark delimiter stack.

`main.ts` is the harness entrypoint: it reads every case from
`/input/cases.json`, renders each with `parse()`, and writes the resulting
array of HTML strings to `/output/html.json`. Outside a container,
`MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` replace `/input` and `/output`.

## Running it

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

## Coverage

Handles the whole of CommonMark 0.31.2 and the GFM 0.29 extensions: ATX and
setext headings, thematic breaks, fenced and indented code, block quotes,
nested bullet/ordered/task lists, tables with alignment, HTML blocks, link
reference definitions, emphasis and strong emphasis by delimiter run,
strikethrough, inline and reference links and images, autolinks and extended
autolinks, entities, and backslash escapes.

## License

MIT. See `LICENSE`.

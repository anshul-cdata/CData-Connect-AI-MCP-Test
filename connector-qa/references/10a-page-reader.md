# Reading web pages — the shared page reader (3.9)

Used by Stage 1.5a (a capability list from API reference pages, `10-capabilities.md` §1.5a) and by
Stage 5.5a (use case evidence from the vendor's own pages, `11-catalog.md` §5.5a), and by the source
checker (`manage-catalog.mjs sources-prep`). The mechanical parts are in `scripts/lib/page-reader.mjs`;
this page is the procedure a model follows.

Many vendor sites are JavaScript applications. A plain fetch — and WebFetch — then returns an empty
shell: Intuit's invoice reference page came back as a 1.27 MB app shell with no operation in it, while
the same page in a browser showed all nine invoice operations. Reading such a site without a browser
is not reading it.

## 1 · Probe one or two pages

Fetch one or two representative pages with plain HTTP (`api-from-docs.mjs probe --url u1,u2` does it
and records the decision in `_agent_out/api-docs/reader.json`) or WebFetch. The page is a **JS shell**
when its text is very short (under `config.capabilities.api_docs.shell_min_chars`, 1500) or, for an
API reference page, has no endpoint-like line ("POST /v3/company/{realmId}/invoice") and shows the signs
of a client-side app (an empty root element, "enable JavaScript", a bundle and no text). `assessPage()`
decides; `probe` prints `READER http` or `READER rendered`.

## 2 · A rendered browser when it is a shell

**First choice since 3.9.3 — `render`, no model in the loop.** When a Chrome, Edge, Chromium or Brave is
installed and Node is 22 or newer, `api-from-docs.mjs render` starts it headless on a throwaway profile,
waits until each page's text stops changing, and writes the text straight to the snapshot store. Page
text never passes through a model's context: no per-page token cost, no transcription errors, no browser
tab to freeze. It reads the same public pages the other readers do, one at a time, `delay_ms` apart, and
**refuses any page `robots.txt` disallows** (excluded with that reason). It applies the strict whole-page
length bar (`shell_min_chars`) and saves nothing for a page that never finishes drawing.

```bash
node "<skill>/scripts/api-from-docs.mjs" render --dir "<dir>" --pending          # every page not yet read
node "<skill>/scripts/api-from-docs.mjs" render --dir "<dir>" --url "<u1>,<u2>"   # or chosen pages
```

`--browser <exe>` (or `CONNECTOR_QA_BROWSER`) names a browser the search does not find. A slow site:
raise `capabilities.api_docs.render_timeout_ms`; a page that keeps drawing late: `render_settle_ms`.

**When `render` cannot be used** — no browser or Node 22, or a page `robots.txt` disallows — use whichever
reader the session has (check with ToolSearch before saying none is), or have a person read the page:

| Reader | How to get a page's text | `--fetcher` |
|---|---|---|
| Claude desktop browser pane | `navigate` to the URL, then `get_page_text` | `browser_pane` |
| Playwright MCP | `browser_navigate`, then `browser_evaluate` with `() => document.body.innerText` | `playwright` |
| Claude in Chrome | `navigate`, then `get_page_text` | `chrome` |
| A person's own browser | `ingest --snippet` prints a console snippet; run it on each page, then `ingest --from <Downloads>` files the downloads | `chrome` (or the browser used) |

A tool that returns the text to the model (the first three rows) still makes the model carry it to disk
word for word; the last row does not. `ingest` matches each download to the inventory page whose last path
segment equals the file's name, refuses a name two pages share rather than guessing, and applies the same
strict length bar. Pages `robots.txt` disallows are read only by a person in their own browser, with their
say-so — the skill never fetches them itself.

**None available → stop and ask the user** to enable Playwright MCP (free, runs locally). Never fall
back to guessing from search snippets or a model's memory of the API, and never use a paid crawler.
Record the reader used (`--fetcher`: `headless` for `render`); it is shown in the reports.

Wait for the page to finish loading (a reference page often fills in after a second or two); text that
still reads as a shell is refused by `snap`, `render` and `ingest`.

## 3 · Save the page's own text — never a summary

`render` and `ingest` save for you. For a reader that hands the text to the model, write the text it
returned to a file and register it:

```bash
node "<skill>/scripts/api-from-docs.mjs" snap --dir "<dir>" --url "<page>" --text-file "<file>" --fetcher playwright
node "<skill>/scripts/api-from-docs.mjs" snap --dir "<dir>" --pending          # plain HTTP, every page not yet read
```

It is saved as `_agent_out/api-docs/<hash>.txt` with its URL in `index.json`; a long page is also cut
into overlapping parts (`<hash>.c1.txt` …, `config.capabilities.api_docs.chunk_chars`) so an extraction
agent reads it whole. WebFetch returns a model's summary, not the page's text: use it to look, never
to save. Use case research saves its pages the same way when it quotes them (`_agent_out/pages/`).

## 4 · Be polite

One request at a time, `delay_ms` apart (1 s); public pages only — never sign in; read `robots.txt`
first (`politeGet` does; a disallowed page is excluded with that reason); no paid crawler; stop on
repeated errors rather than retrying in a loop.

## 5 · Every page accounted for

Build the page list from the site's own index — `sitemap.xml`, the docs navigation, or an index page
(`api-from-docs.mjs inventory --sitemap | --index | --urls`). A navigation drawn by JavaScript is read
in the rendered browser: `() => [...document.querySelectorAll('a[href]')].map(a => a.href).join('\n')`,
saved to a file and passed as `--urls`. Every page in the inventory ends **extracted** or **excluded with
a reason** (`exclude --url | --match --why "…"`; pages outside `--include`, and pages robots.txt
disallows, are excluded automatically). `api-from-docs.mjs status` exits 3 until that holds.

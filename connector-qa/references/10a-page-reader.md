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

Use whichever is available in the session — check with ToolSearch before saying none is:

| Reader | How to get a page's text | `--fetcher` |
|---|---|---|
| Claude desktop browser pane | `navigate` to the URL, then `get_page_text` | `browser_pane` |
| Playwright MCP | `browser_navigate`, then `browser_evaluate` with `() => document.body.innerText` | `playwright` |
| Claude in Chrome | `navigate`, then `get_page_text` | `chrome` |

**None available → stop and ask the user** to enable Playwright MCP (free, runs locally). Never fall
back to guessing from search snippets or a model's memory of the API, and never use a paid crawler.
Record the reader used (`--fetcher`); it is shown in the reports.

Wait for the page to finish loading (a reference page often fills in after a second or two); text that
still reads as a shell is refused by `snap`.

## 3 · Save the page's own text — never a summary

Write the text the reader returned to a file and register it:

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

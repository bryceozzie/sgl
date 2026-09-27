# @link {#key/link}

Makes a node or edge a link, in the drawing and in the exported SVG. Only `https:` and `mailto:` addresses are allowed.

Aliases: url, hyperlink, href, clickable

Diagnostics: SGL6001

The link opens in a new tab. Any other kind of address, a `#` link within the document included, is removed with a warning.

```sgl example title="Links to a page and an address" contains="https://example.com/runbook"
docs: { @label: "Runbook", @link: "https://example.com/runbook" }
team: { @link: "mailto:team@example.com" }
```

```sgl example title="Not an allowed address" expect=SGL6001
api: { @link: "javascript:alert(1)" }
```

See also: [Tooltip](#help/key/tooltip)

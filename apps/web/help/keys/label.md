# @label {#key/label}

The text shown on a node, container or edge, in place of its name. It reads a little Markdown: bold, italic, code and line breaks.

Aliases: text, caption, name, markdown, bold, italic

Diagnostics: SGL2011

`api: "Payments API"` is a shorthand for `api: { @label: "Payments API" }`, and `a -> b: "reads"` labels an edge. Without a label, a node shows its name.

| Write | Get |
|---|---|
| `**bold**` | **bold** |
| `*italic*` | *italic* |
| `` `code` `` | `code`, in a monospace face |
| `\n`, or a new line in `"""…"""` | a line break |
| `\*` or `` \` `` | a literal star or backtick |

A star next to a letter or digit stays a star, so `2*3*4` and `snake_case` read as written.

```sgl example title="Markdown in labels"
api: {
  @label: """
    **Payments API**
    handles `POST /pay`
    """
}
db: "Ledger"
api -> db: "*async*"
```

To wrap a long label, give the node a maximum width.

```sgl example title="A label that wraps"
api: { @label: "A service with a rather long name", @size: { maxWidth: 120 } }
```

A label is text, so a number or a list is ignored with a warning.

```sgl example title="Not text" expect=SGL2011
api: { @label: 42 }
```

See also: [Size](#help/key/size), [Title](#help/key/title), [Accessibility](#help/key/a11y)

# @tooltip {#key/tooltip}

Text for a node or edge to show on hover. It is kept in the document, but this version does not draw it yet.

Aliases: hover, hint text, title attribute

It is plain text. For text that screen readers announce, use `@a11y.description`, which is drawn.

```sgl example title="A tooltip, kept for later"
api: { @tooltip: "Owned by the payments team" }
```

See also: [Accessibility](#help/key/a11y), [Link](#help/key/link)

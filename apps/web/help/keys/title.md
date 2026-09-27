# @title {#key/title}

The document's name: Documents lists it by this name, Save uses it for the file name, and the SVG uses it as its accessible title.

Aliases: name, document name, file name

Diagnostics: SGL2012

Without `@title`, the document is named after its first node. The title is plain text: Markdown is not read here.

```sgl example title="A named document"
@title: "Checkout flow"
cart
payment
cart -> payment
```

`@title` is for the document root. To name a node, give it a label.

```sgl example title="Not on a node" expect=SGL2012
cart: { @title: "Cart" }
```

See also: [Label](#help/key/label), [Accessibility](#help/key/a11y)

# @vars {#key/vars}

Declares variables: `$name` uses a value whole, and `${name}` puts it inside a string. At the root or on any container.

Aliases: variables, constants, substitution, dollar

Diagnostics: SGL2013, SGL2014

Variables work in configuration values and labels, never in keys, paths or node names. A container's `@vars` apply to everything inside it and shadow the ones outside. There are no expressions: SGL is a data language.

```sgl example title="A colour and a word, declared once"
@vars: { brand: "#4F46E5", tier: "production" }
api: {
  @label: "API (${tier})"
  @style.stroke: $brand
}
```

A name no `@vars` declares is an error, and the value that uses it is dropped.

```sgl example title="An unknown variable" expect=SGL2013 preview=false
api: { @label: "API (${tier})" }
```

Inside one `@vars` block, an entry may use only the entries before it.

```sgl example title="Used before it is declared" expect=SGL2014 preview=false
@vars: { a: $b, b: 1 }
x: { @order: $a }
```

See also: [Label](#help/key/label), [Imports](#help/key/imports)

# @direction {#key/direction}

A shorthand for `@layout.direction`: which way the layout flows, `down`, `up`, `left` or `right`.

Aliases: flow, orientation, left to right, top to bottom

Diagnostics: SGL4010

It is checked like any `@layout` key. `elk` has a `direction` option, but in this version the direction that reaches it is the one set in the toolbar's Options, so `@direction` in the document does not change the layout yet. `grid` and `fixed` have no direction, so under them it is ignored with a warning. Under `tree`, `@direction` on a container turns the tree inside it, and containers inside that one take the same direction unless they set their own.

```sgl snippet
@direction: right
```

```sgl example title="A container flowing right inside a tree" engine=tree
@layout: { engine: tree }
hq
sales: {
  @direction: right
  lead
  emea
  amer
  lead -> emea
  lead -> amer
}
hq -> sales
```

```sgl example title="grid has no direction" engine=grid expect=SGL4010
@direction: right
a
b
```

See also: [Layout](#help/key/layout)

# @direction {#key/direction}

A shorthand for `@layout.direction`: which way the layout flows, `down`, `up`, `left` or `right`.

Aliases: flow, orientation, left to right, top to bottom

Diagnostics: SGL4010, SGL2011

At the document root it sets the engine's `direction` option, like any root `@layout` option: it reaches the engine and overrides Direction in the toolbar's Options for this document, which then shows "Direction (set by document)". If the document also sets `@layout.direction`, that one wins.

`elk` and `tree` have a `direction` option. `grid`, `fixed` and `radial` have none, so under them it is ignored with a warning.

On a container, `@direction` is a hint for the engine around it. Under `tree` it turns the tree inside the container, and containers inside that one take the same direction unless they set their own. `elk`, `grid`, `fixed` and `radial` have no such hint, so there it is ignored with a warning. To turn a container under `elk`, give it an engine of its own, `@layout: { engine: elk, direction: right }`; then `@direction` inside the same container sets that engine's option.

```sgl snippet
@direction: right
```

```sgl example title="Left to right" engine=elk contains="0 0 388 68"
@direction: right
web
api
db
web -> api -> db
```

```sgl example title="@layout.direction wins" engine=elk
@direction: right
@layout.direction: up
web
api
db
web -> api -> db
```

```sgl example title="Not a direction" engine=elk expect=SGL2011
@direction: sideways
web
api
web -> api
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

```sgl example title="A container's own direction under elk"
top
row: {
  @layout.engine: elk
  @direction: right
  a
  b
  a -> b
}
top -> row
```

```sgl example title="Not a hint for elk" expect=SGL4010
row: {
  @direction: right
  a
  b
  a -> b
}
```

```sgl example title="grid has no direction" engine=grid expect=SGL4010
@direction: right
a
b
```

See also: [Layout](#help/key/layout)

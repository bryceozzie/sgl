# @direction {#key/direction}

A shorthand for `@layout.direction`: which way the layout flows, `down`, `up`, `left` or `right`.

Aliases: flow, orientation, left to right, top to bottom

Diagnostics: SGL4010

It is checked like any `@layout` key. `elk` has a `direction` option, but in this version the direction that reaches it is the one set in the toolbar's Options, so `@direction` in the document does not change the layout yet. `grid` and `fixed` have no direction, so under them it is ignored with a warning.

```sgl snippet
@direction: right
```

```sgl example title="grid has no direction" engine=grid expect=SGL4010
@direction: right
a
b
```

See also: [Layout](#help/key/layout)

# @layout {#key/layout}

Chooses the layout engine at the document root, and gives an engine hints on a container. It is an object; `@layout.<key>` sets one key.

Aliases: engine, layout engine, arrange

Diagnostics: SGL4010

At the root, `engine` picks the engine for this document, overriding the Engine picker. The other keys are the engine's options, listed on its engine page. Each is checked, and a key the engine does not have is ignored with a warning. In this version the options that reach the engine are the ones set in the toolbar's Options; an option written in the document does not change the layout yet.

```sgl example title="A grid, chosen by the document" engine=grid
@layout: { engine: grid }
a
b
c
d
```

```sgl example title="A key the engine does not have" engine=elk expect=SGL4010
@layout: { engine: elk, columns: 2 }
a
b
a -> b
```

On a container, the keys are hints for the engine that lays out the whole document. A container cannot pick an engine of its own: a different `engine` there is ignored with a warning.

```sgl example title="A container cannot change the engine" expect=SGL4010,SGL4010
payments: {
  @layout: { engine: grid, columns: 2 }
  api
  ledger
}
```

See also: [Layout engine](#help/key/layout.engine), [Engine hints](#help/key/layout.*), [Direction](#help/key/direction)

## @layout.engine {#key/layout.engine}

The engine that lays out the document, by its short name, `elk`, `grid` or `fixed`, or its full id, such as `sgl.grid`. It overrides the Engine picker.

Aliases: engine, elk, grid, fixed

Write it at the document root, as `@layout: { engine: grid }` or `@layout.engine: grid`. `elk` draws layered diagrams with routed edges; `grid` places nodes in rows and columns; `fixed` places each node at its `@pin`.

```sgl example title="The short form" engine=grid
@layout.engine: grid
web
api
db
```

See also: [Layout](#help/key/layout)

## Engine hints {#key/layout.*}

`@layout.<hint>` on a node, container or edge passes a hint to the engine. Which hints exist depends on the engine; its engine page lists them.

Aliases: hint, layout hint, columns, priority

Diagnostics: SGL4010

A hint the engine does not know is ignored with a warning. Under `grid`, a container's `@layout.columns` sets how many columns its children take.

```sgl example title="One column inside a container" engine=grid
queue: {
  @layout.columns: 1
  first
  second
  third
}
```

Under `elk`, an edge's `@layout.priority` asks elk to favour that edge, keeping it pointing along the layout's direction.

```sgl example title="An edge with a higher priority"
api
db
cache
api -> db: { @layout.priority: 5 }
api -> cache
```

```sgl example title="A hint elk does not have" expect=SGL4010
api: { @layout.columns: 2 }
```

See also: [Layout](#help/key/layout)

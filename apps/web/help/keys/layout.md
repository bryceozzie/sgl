# @layout {#key/layout}

Chooses the layout engine at the document root, and on a container either gives it an engine of its own or passes hints to the engine around it. It is an object; `@layout.<key>` sets one key.

Aliases: engine, layout engine, arrange

Diagnostics: SGL4010, SGL2011, SGL4012

At the root, `engine` picks the engine for this document, overriding the Engine picker. The other keys are the engine's options, listed on its engine page, and they reach the engine. Each one the document sets overrides the toolbar's Options for this document only: Options shows that field with the document's value, disabled, and its label ends "(set by document)". Delete the key and the value in Options applies again.

```sgl example title="A grid, chosen by the document" engine=grid
@layout: { engine: grid }
a
b
c
d
```

```sgl example title="Two columns, set by the document" engine=grid
@layout: { engine: grid, columns: 2, gap: 40 }
a
b
c
d
```

```sgl example title="Left to right under elk" engine=elk contains="0 0 448 68"
@layout: { engine: elk, direction: right, rankSpacing: 100 }
web
api
db
web -> api -> db
```

A key the engine does not have as an option is ignored with a warning (`SGL4010`). At the root only options count: a hint such as elk's `priority` belongs on a node or an edge.

```sgl example title="A key the engine does not have" engine=elk expect=SGL4010
@layout: { engine: elk, columns: 2 }
a
b
a -> b
```

```sgl example title="A hint is not an option" engine=elk expect=SGL4010
@layout: { engine: elk, priority: 5 }
a
b
a -> b
```

A value the engine cannot use is ignored with a warning (`SGL2011`), and the value in Options applies instead. The values allowed are those Options allows: for example, elk's spacings go up to 500.

```sgl example title="A value the engine cannot use" engine=elk expect=SGL2011
@layout: { engine: elk, nodeSpacing: 900 }
a
b
```

A container whose `@layout` names an `engine` is laid out by that engine, with everything inside it, as if it were a small document of its own. The engine around it places it as one box. Its other keys are that engine's options, checked as the root's are.

```sgl example title="A grid inside an elk document" engine=elk
@layout: { engine: elk, direction: right }
storefront
payments: {
  @layout: { engine: grid, columns: 2 }
  api
  ledger
  outbox
}
psp
storefront -> payments.api
payments.api -> psp
```

A `fixed` container keeps its children at their pins, whatever engine lays out the rest of the document.

```sgl example title="Pins inside a fixed container" engine=elk
@layout: { engine: elk }
client
rack: {
  @layout: { engine: fixed }
  top: { @pin: { x: 0, y: 0 } }
  bottom: { @pin: { x: 60, y: 50 } }
}
client -> rack
```

An option the container does not set comes from the nearest container around it, or the root, that uses the same engine, and otherwise is the engine's default. So a container that names the document's own engine keeps the document's other options, and changes only what it sets.

```sgl example title="The same engine, another direction" engine=elk
@layout: { engine: elk, nodeSpacing: 20 }
top
row: {
  @layout: { engine: elk, direction: right }
  a
  b
  c
  a -> b -> c
}
top -> row
```

An engine that is not available is ignored with a warning (`SGL4012`), and the container is laid out by the engine around it. If a container's engine fails, the engine around it lays the container out instead, with a warning (`SGL4013`).

```sgl example title="An engine that is not available" expect=SGL4012
box: {
  @layout: { engine: dagre }
  a
  b
}
```

On a container that names no engine, the keys are hints for the engine around it. An option there is not a hint, so it is ignored with a warning: to change it inside the container, give the container an engine.

```sgl example title="An option on a plain container" expect=SGL4010
box: {
  @layout: { nodeSpacing: 10 }
  a
  b
}
```

See also: [Layout engine](#help/key/layout.engine), [Engine hints](#help/key/layout.*), [Direction](#help/key/direction)

## @layout.engine {#key/layout.engine}

The engine that lays out the document, by its short name, `elk`, `grid`, `fixed`, `tree` or `radial`, or its full id, such as `sgl.grid`. It overrides the Engine picker.

Aliases: engine, elk, grid, fixed, tree, radial

Write it at the document root, as `@layout: { engine: grid }` or `@layout.engine: grid`. On a container, it gives that container an engine of its own. `elk` draws layered diagrams with routed edges; `grid` places nodes in rows and columns; `fixed` places each node at its `@pin`; `tree` draws each container's children as a tidy tree, parents centred above their children, joined by elbow edges; `radial` puts each tree's root at the centre and its descendants on rings around it, one ring per level.

```sgl example title="The short form" engine=grid
@layout.engine: grid
web
api
db
```

```sgl example title="A tree" engine=tree
@layout: { engine: tree }
ceo: "CEO"
cto: "CTO"
cfo: "CFO"
dev: "Developers"
ceo -> cto
ceo -> cfo
cto -> dev
```

Under `tree`, an edge that is not part of the tree, such as a second parent or an edge back up a cycle, is drawn as a straight line.

```sgl example title="The same hierarchy, radial" engine=radial
@layout: { engine: radial }
hub: "Hub"
a: "North"
b: "East"
c: "South"
d: "West"
a1: "Leaf"
hub -> a
hub -> b
hub -> c
hub -> d
a -> a1
```

Under `radial`, each subtree gets a slice of the circle in proportion to its size, starting at 12 o'clock and going clockwise, and every edge is a straight line. Separate trees are drawn side by side, each around its own centre.

See also: [Layout](#help/key/layout)

## Engine hints {#key/layout.*}

`@layout.<hint>` on a node, container or edge passes a hint to the engine. Which hints exist depends on the engine; its engine page lists them.

Aliases: hint, layout hint, columns, priority, root

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

Under `tree` and `radial`, a node's `@layout.root: true` makes it the root of a tree even when an edge points to it (under `radial`, the centre of its rings). Under `tree`, a container's `@layout.direction` turns the tree inside it.

```sgl example title="A root chosen by a hint" engine=tree
@layout: { engine: tree }
client
api: { @layout.root: true }
auth
db
client -> api
api -> auth
api -> db
```

```sgl example title="A hint elk does not have" expect=SGL4010
api: { @layout.columns: 2 }
```

See also: [Layout](#help/key/layout)

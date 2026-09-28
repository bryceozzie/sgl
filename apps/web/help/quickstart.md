# Quick start {#topic/quickstart}

Type on the left and the diagram draws itself on the right. Five short steps cover nodes, edges, labels, containers, classes, engines, themes and sharing.

Aliases: getting started, tutorial, basics, first steps

## Nodes and edges

A name on its own line is a node. `a -> b` draws an edge from `a` to `b`. Both ends must be declared; an edge to a name that does not exist is skipped with an error.

```sgl example title="Two nodes and an edge"
api
db
api -> db
```

Use `<-` to point the other way, `<->` for arrowheads at both ends and `--` for none. A chain such as `a -> b -> c` makes one edge per step.

## Labels

A string after a node's name is its label; without one, the name is shown. An edge takes a label the same way. Labels read a little Markdown: `**bold**`, `*italic*` and `` `code` ``.

```sgl example title="Labels on nodes and an edge"
api: "Payments **API**"
db: "Ledger"
api -> db: "writes"
```

## Containers

A name followed by a block `{ … }` is a container. Inside the block, a key that starts with `@` configures the container, and anything else is a child. An edge reaches inside with a dotted path.

```sgl example title="A container with two children"
platform: {
  @label: "Platform"
  api
  auth
  api -> auth
}
web
web -> platform.api
```

## Classes

Declare a look once in `@classes`, then give it to nodes by name.

```sgl example title="One class, used twice"
@classes: {
  Store: { @shape: cylinder, @style: { fill: "@surface.sunken" } }
}
orders: Store
ledger: Store
orders -> ledger
```

## Engine, theme and sharing

- **Engine** in the toolbar chooses how the diagram is laid out: `elk` draws layered diagrams, `grid` places nodes in rows and columns, `fixed` puts each node where its `@pin` says, and `tree` draws a hierarchy as a tidy tree, parents above their children.
- **Theme** chooses the colours.
- A document can choose for itself with `@layout: { engine: grid }` and `@theme`, and the toolbar then says so.
- **Share** makes a link that carries the whole document inside it. Nothing is uploaded.

```sgl example title="A document that picks its engine and theme" engine=grid
@title: "Services"
@theme: "neutral-dark"
@layout: { engine: grid }
api
auth
db
```

See also: [Labels](#help/key/label), [Classes](#help/key/classes), [Layout](#help/key/layout), [Theme](#help/key/theme)

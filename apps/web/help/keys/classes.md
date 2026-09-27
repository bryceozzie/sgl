# @classes {#key/classes}

Declares reusable classes at the document root. A class is a named bundle of configuration, such as a shape and a style, that nodes and edges take by name.

Aliases: class, reusable style, stereotype, type

Diagnostics: SGL2007

Each class body holds `@` keys only: `@label`, `@shape`, `@style`, `@size`, `@ports`, `@meta` and `@extends`. A node takes a class with `node: ClassName` or `@type`.

```sgl example title="Two classes"
@classes: {
  Service: { @shape: round }
  Store: { @shape: cylinder, @style.fill: "@surface.sunken" }
}
api: Service
db: Store
api -> db
```

What a node sets itself beats what its classes set.

```sgl example title="The node's own style wins"
@classes: {
  Store: { @shape: cylinder, @style: { fill: "@surface.sunken" } }
}
db: Store
cache: { @type: Store, @style.fill: "#fde68a" }
```

A class body cannot hold child nodes: they are ignored with a warning.

```sgl example title="Configuration only" expect=SGL2007
@classes: { Service: { @shape: round, inner: {} } }
api: Service
```

See also: [Type](#help/key/type), [Extends](#help/key/extends), [Imports](#help/key/imports)

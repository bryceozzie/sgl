# @hidden {#key/hidden}

`@hidden: true` leaves a node, container or edge out of the drawing while keeping it in the document.

Aliases: hide, invisible, draft, comment out

Diagnostics: SGL3002

A hidden container hides everything in it. Edges to a hidden node are not drawn either, with a note saying how many. Wildcard edges skip hidden nodes.

```sgl example title="A hidden node and its edge" expect=SGL3002
api
legacy: { @hidden: true }
db
api -> db
api -> legacy
```

```sgl example title="A hidden edge"
a
b
a -> b: { @hidden: true }
```

See also: [Meta](#help/key/meta)

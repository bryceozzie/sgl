# @shape {#key/shape}

The outline a node is drawn with, such as `round`, `cylinder` or `diamond`. A node with no shape is a rectangle.

Aliases: outline, box, cylinder, database, diamond, decision

Diagnostics: SGL3001, SGL3006

A shape is a node's or a class's. The label sits inside the shape, and the node grows to fit it, so an ellipse or a diamond is larger than a rectangle with the same label.

```sgl example title="Some of the shapes"
start: { @shape: round }
check: { @label: "Valid?", @shape: diamond }
store: { @shape: cylinder }
start -> check -> store
```

Some shapes in the language are not drawn yet in this version: they draw as a rectangle, with a note. A name that is not a shape at all draws as a rectangle, with a warning.

```sgl example title="Not drawn yet, and not a shape" expect=SGL3006,SGL3001
sky: { @shape: cloud }
blob: { @shape: blob }
```

See also: [Classes](#help/key/classes), [Size](#help/key/size)

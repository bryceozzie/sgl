# @edges {#key/edges}

The canonical JSON form of a container's edges: a list of `{ from, to, directed }` objects. In `.sgl` text you write `a -> b` instead.

Aliases: edge list, json edges, canonical form, arrows

Saving as JSON turns every `a -> b` into an item of its container's `@edges`, and reading JSON turns them back. `directed` is `forward` (the default), `both` or `none`, and an item may carry `@` keys such as `@label`.

```sgl example title="The same edge, written both ways"
a
b
c
a -> b: "infix"
@edges: [{ from: "b", to: "c", directed: "forward", @label: "canonical" }]
```

See also: [Ports](#help/key/ports)

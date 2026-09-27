# @order {#key/order}

A number that sorts a node or edge among its siblings. It is kept, but the engines in this version do not read it: declaration order decides.

Aliases: sort, sequence, position in list

To change the order today, change the order of the lines.

```sgl example title="An order, kept for later"
first: { @order: 1 }
second: { @order: 2 }
first -> second
```

See also: [Layout](#help/key/layout)

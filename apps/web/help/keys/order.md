# @order {#key/order}

A number that sorts a node or edge among its siblings. In this version only `tree` reads it; the other engines keep declaration order.

Aliases: sort, sequence, position in list

Under `tree`, among the children of one node in a tree, lower numbers come first, and a node without `@order` comes after those with one. Under the other engines, change the order of the lines instead.

```sgl example title="Children in the order @order gives" engine=tree
@layout: { engine: tree }
lead
first: { @order: 2 }
second: { @order: 1 }
lead -> first
lead -> second
```

See also: [Layout](#help/key/layout)

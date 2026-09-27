# @type {#key/type}

Gives a node or an edge one or more classes from `@classes`. With several, they apply in order and a later class wins.

Aliases: class, classes, apply class

Diagnostics: SGL2002

`db: Store` is a shorthand for `db: { @type: Store }`. For more than one class, write a list.

```sgl example title="Two classes on one node"
@classes: {
  Store: { @shape: cylinder }
  Critical: { @style: { stroke: "@danger", strokeWidth: 3 } }
}
db: { @type: [Store, Critical] }
api
api -> db
```

An edge takes classes the same way.

```sgl example title="A class on an edge" contains="stroke-dasharray:6 3"
@classes: { Async: { @style: { strokeDash: "6 3" } } }
api
queue
api -> queue: { @type: Async }
```

A class that `@classes` does not declare is an error. A bareword after a node's name is always a class, so write a label in quotes.

```sgl example title="An undeclared class" expect=SGL2002 preview=false
api: Payments
```

See also: [Classes](#help/key/classes), [Label](#help/key/label)

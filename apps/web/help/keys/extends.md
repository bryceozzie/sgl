# @extends {#key/extends}

Makes a class build on another: `@extends: Base` in a class body gives it everything `Base` sets, and its own keys win.

Aliases: inherit, inheritance, base class, subclass

Diagnostics: SGL2004

It is a class's only, and takes one class or a list. A chain of classes that extends itself is an error.

```sgl example title="A class that builds on another"
@classes: {
  Service: { @shape: round }
  Critical: { @extends: Service, @style: { stroke: "@danger", strokeWidth: 3 } }
}
api: Service
payments: Critical
api -> payments
```

```sgl example title="A cycle" expect=SGL2004 preview=false
@classes: {
  A: { @extends: B }
  B: { @extends: A }
}
x: A
```

See also: [Classes](#help/key/classes), [Type](#help/key/type)

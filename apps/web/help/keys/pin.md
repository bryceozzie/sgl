# @pin {#key/pin}

Places a node or container at `{ x, y }`, in pixels: where the top-left of its frame goes, relative to the top-left of its parent's content box.

Aliases: position, coordinates, fixed position, place, x y

Diagnostics: SGL2011, SGL4021

For a node at the document root, the origin is the diagram's own. Both numbers are required, each between -100 000 and 100 000; otherwise the whole pin is dropped with a warning. `@pin` is a node's own, so it is not valid on an edge, a class or the root.

Pins are honoured only by the `fixed` engine. The engines in this build, `elk` and `grid`, do not honour them: they lay the node out as usual and warn that the pin is ignored.

```sgl example title="A pin, ignored by elk" expect=SGL4021
api: { @pin: { x: 40, y: 20 } }
db
api -> db
```

```sgl example title="Both numbers are required" expect=SGL2011
api: { @pin: { x: 40 } }
```

See also: [Layout](#help/key/layout), [Size](#help/key/size)

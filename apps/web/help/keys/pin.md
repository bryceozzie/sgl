# @pin {#key/pin}

Places a node or container at `{ x, y }`, in pixels: where the top-left of its frame goes, relative to the top-left of its parent's content box.

Aliases: position, coordinates, fixed position, place, x y, manual layout

Diagnostics: SGL2011, SGL4020, SGL4021

Pins are honoured by the `fixed` engine, which puts every pinned node exactly where it says and draws straight edges between them.

```sgl example title="Three pinned nodes" engine=fixed
@layout: { engine: fixed }
web: { @pin: { x: 0, y: 0 } }
api: { @pin: { x: 200, y: 0 } }
db: { @pin: { x: 200, y: 120 } }
web -> api -> db
```

At the document root, pins fix the nodes' places relative to each other, and the drawing is framed to fit: moving every root pin by the same amount draws the same diagram. Inside a container, a pin is measured from the container's content box, below its title, so nested pins add up.

```sgl example title="Pins inside a pinned container" engine=fixed
@layout: { engine: fixed }
platform: {
  @pin: { x: 0, y: 0 }
  api: { @pin: { x: 0, y: 0 } }
  auth: { @pin: { x: 140, y: 0 } }
  api -> auth
}
```

Under `fixed`, a node without a pin is placed below the pinned ones, with a warning for each.

```sgl example title="A node without a pin" engine=fixed expect=SGL4020
@layout: { engine: fixed }
web: { @pin: { x: 0, y: 0 } }
api
web -> api
```

Both numbers are required, each between -100 000 and 100 000; otherwise the whole pin is dropped with a warning. `@pin` is a node's own, so it is not valid on an edge, a class or the root.

```sgl example title="Both numbers are required" engine=fixed expect=SGL2011,SGL4020
@layout: { engine: fixed }
api: { @pin: { x: 40 } }
```

`elk` and `grid` do not honour pins: they lay the node out as usual and warn that the pin is ignored.

```sgl example title="A pin, ignored by elk" expect=SGL4021
api: { @pin: { x: 40, y: 20 } }
db
api -> db
```

See also: [Layout engine](#help/key/layout.engine), [Size](#help/key/size)

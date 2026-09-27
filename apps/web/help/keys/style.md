# @style {#key/style}

Paints one node, container, edge or class: fill, stroke, dashes, text and more. It is always an object; `@style.fill: …` sets one property.

Aliases: colour, color, fill, stroke, dashed, dotted, paint, css

Diagnostics: SGL2011, SGL5003, SGL5004, SGL5005

Each property has a page of its own, under Style properties. A colour may be a token such as `"@accent"`, which follows the theme. What an element sets itself beats what its classes set.

```sgl example title="A dashed, thicker edge" contains="stroke-dasharray:6 3"
api
queue
api -> queue: { @label: "async", @style: { strokeDash: "6 3", strokeWidth: 2 } }
```

```sgl example title="One property at a time"
alert: {
  @style.fill: "@danger"
  @style.strokeWidth: 3
}
```

`strokeDash` also takes `solid`, `dashed` and `dotted`.

> **Wrong.** `@style: dashed` is not a shorthand. A `@style` that is not an object is ignored with a warning. Write `@style: { strokeDash: dashed }`.

```sgl example title="Not an object" expect=SGL2011
a
b
a -> b: { @style: dashed }
```

A property the theme does not know, a value of the wrong kind, and a token no theme defines are each a warning. An unknown token draws in a fallback colour, so it is easy to spot.

```sgl example title="Three mistakes" expect=SGL5003,SGL5004,SGL5005
api: { @style: { colour: red, strokeWidth: "thick", fill: "@brand" } }
```

See also: [Theme](#help/key/theme), [Classes](#help/key/classes), [Variables](#help/key/vars)

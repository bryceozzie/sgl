# @size {#key/size}

Sets a node's width and height, fixed or within limits, in pixels. It is an object of size keys, on a node or a class.

Aliases: dimensions, width, height, resize, bigger

Diagnostics: SGL2010, SGL2012

Without `@size`, a node is as large as its label needs. A class's `@size` applies to its nodes, and a node's own keys beat its classes', key by key. A container's size comes from its children, so `@size` on a container is ignored with a warning.

```sgl example title="A fixed size and a minimum"
wide: { @size: { width: 180, height: 60 } }
tall: { @size: { minHeight: 90 } }
wide -> tall
```

```sgl example title="An unknown key, and a container" expect=SGL2010,SGL2012
api: { @size: { depth: 3 } }
group: {
  @size: { width: 300 }
  inner
}
```

See also: [Label](#help/key/label), [Shape](#help/key/shape)

## @size.width {#key/size.width}

A fixed width in pixels. The label wraps to fit it at spaces, and a word too long for it overflows.

Aliases: fixed width

```sgl example title="A fixed width"
api: { @label: "Payments service gateway", @size.width: 110 }
```

See also: [Maximum width](#help/key/size.maxWidth), [Height](#help/key/size.height)

## @size.height {#key/size.height}

A fixed height in pixels.

Aliases: fixed height

```sgl example title="A tall node"
api: { @size.height: 90 }
```

See also: [Width](#help/key/size.width)

## @size.minWidth {#key/size.minWidth}

The narrowest the node may be, in pixels. A longer label still makes it wider.

Aliases: minimum width

```sgl example title="Two nodes, the same minimum width"
a: { @size.minWidth: 140 }
bb: { @label: "A longer label here", @size.minWidth: 140 }
a -> bb
```

See also: [Minimum height](#help/key/size.minHeight)

## @size.minHeight {#key/size.minHeight}

The shortest the node may be, in pixels.

Aliases: minimum height

```sgl example title="A minimum height"
api: { @size.minHeight: 70 }
```

See also: [Minimum width](#help/key/size.minWidth)

## @size.maxWidth {#key/size.maxWidth}

The widest the node may be, in pixels. A longer label wraps onto more lines, at spaces, and a word too long for a line is split.

Aliases: wrap, wrapping, line break, maximum width

```sgl example title="Wrap a long title" contains=">second line</tspan>"
api: { @label: "A long title that wraps onto a second line", @size: { maxWidth: 120 } }
```

With both `maxWidth` and `width`, the narrower wins.

See also: [Label](#help/key/label), [Width](#help/key/size.width)

## @size.aspectRatio {#key/size.aspectRatio}

The node's width divided by its height. The layout engines in this version do not apply it yet.

Aliases: ratio, proportion, square

```sgl snippet
api: { @size.aspectRatio: 2 }
```

See also: [Size](#help/key/size)

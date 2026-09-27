# @ports {#key/ports}

Names points on a node's edge for edges to attach to: each port is a name and a side, `north`, `south`, `east` or `west`.

Aliases: port, anchor, attach, connector

Diagnostics: SGL2003, SGL3007

An edge names a port in brackets after the node: `client -> router[in]`. `elk` and `fixed` attach the edge at the port's side; `grid` does not place ports and attaches to the node's outline.

```sgl example title="An input and an output"
router: { @ports: { in: west, out: east } }
client
server
client -> router[in]
router[out] -> server
```

An edge to a port the node does not have attaches to the node instead, with a warning. A side that is not one of the four is taken as `east`, with a warning.

```sgl example title="A missing port and a wrong side" expect=SGL2003,SGL3007
router: { @ports: { in: west, out: sideways } }
client
client -> router[admin]
```

See also: [Edges](#help/key/edges)

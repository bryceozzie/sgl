# @meta {#key/meta}

Your own data on the document, a node, an edge or a class: owners, tickets, anything. It is never drawn, and it is kept exactly through saving and sharing.

Aliases: metadata, data, notes, custom fields, owner

Any value is allowed, and nothing reads it but you and your tools.

```sgl example title="Data that travels with the diagram"
@meta: { reviewed: "2026-09-01" }
api: { @meta: { owner: "payments", ticket: "PAY-142" } }
db
api -> db: { @meta.protocol: "tcp" }
```

See also: [Hidden](#help/key/hidden)

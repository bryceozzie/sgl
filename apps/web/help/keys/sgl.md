# @sgl {#key/sgl}

The language version a document is written in. It is optional in `.sgl` text, and a document saved as JSON always carries `"@sgl": "1.0"`.

Aliases: version, language version

Diagnostics: SGL2012

Write it at the document root, usually first. This version does not check its value.

```sgl example title="A document that states its version"
@sgl: "1.0"
api
db
api -> db
```

It belongs to the whole document, so anywhere else it is ignored with a warning.

```sgl example title="Not on a node" expect=SGL2012
api: { @sgl: "1.0" }
```

See also: [Title](#help/key/title)

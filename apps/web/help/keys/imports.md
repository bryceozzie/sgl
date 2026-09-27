# @imports {#key/imports}

Brings classes and variables, and optionally nodes, from your other stored documents. It is a list of relative paths, at the document root.

Aliases: import, include, reuse, library

Diagnostics: SGL2025

Each item is a path string, or `{ path: "…", as: name }`. A path finds one of your stored documents (Documents) by its last part, ignoring case and the extension, so `./shared/classes.sgl` finds the document called `classes`. Nothing is ever fetched from the network.

```sgl snippet
@imports: [
  "./classes",
  { path: "./aws", as: aws }
]
lambda: aws.Lambda
```

- **Without `as`**, you get the document's `@classes` and root `@vars`, under their own names.
- **With `as: aws`**, its classes are `aws.Name`, its variables `$aws.name`, and its nodes and edges arrive in a container `aws`.

Your own classes and variables win over imported ones. A failed import is a warning, and the rest of the document still draws. A path that is not relative is refused.

```sgl example title="Only relative paths" expect=SGL2025
@imports: ["/shared/classes.sgl"]
api
```

See also: [Classes](#help/key/classes), [Variables](#help/key/vars)

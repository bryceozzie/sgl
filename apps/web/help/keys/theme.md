# @theme {#key/theme}

Chooses the document's theme, by the name of a built-in theme. It overrides the Theme picker for this document.

Aliases: colours, colour scheme, dark mode, print

Write it at the document root. While a document sets its theme, the Theme picker shows that it is set by the document. A name that is not a built-in theme draws in the default theme.

```sgl example title="A dark diagram"
@theme: "neutral-dark"
api
db
api -> db
```

Colours written as tokens, such as `"@accent"`, follow the theme, so the same document reads well in every theme.

```sgl example title="Tokens follow the theme"
@theme: "print"
alert: { @style: { stroke: "@danger", strokeWidth: 2 } }
ok
alert -> ok
```

See also: [Style](#help/key/style), [Quick start](#help/topic/quickstart)

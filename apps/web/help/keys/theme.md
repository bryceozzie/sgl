# @theme {#key/theme}

Chooses the document's theme, by the name of a built-in theme. It overrides the Theme picker for this document.

Aliases: colours, colour scheme, dark mode, print

Diagnostics: SGL5007

Write it at the document root. While a document sets its theme, the Theme picker shows that it is set by the document.

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

A name that is not a built-in theme, such as a typo, is a warning at the key, and the document draws in the default theme. Names are exact: `"Neutral-Dark"` is not `"neutral-dark"`.

```sgl example title="A typo" expect=SGL5007
@theme: "neutral-drak"
api
db
api -> db
```

See also: [Style](#help/key/style), [Quick start](#help/topic/quickstart)

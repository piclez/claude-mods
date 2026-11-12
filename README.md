# claude-mods

Claude Code mods.

| Mod | What it does |
| --- | --- |
| `agent-chart` | Right-side pane with a live timeline chart of subagents: when each starts, what tool it is on, and how it ended |
| `working-on` | Right-side pane showing what the session is working on, each task labelled by TypeSafe Jev with a category and a suggested model; can route each prompt to a model |

`working-on` asks for a TypeSafe API key and a routing mode at install. Both are optional: without a key the
pane shows the summary only, and routing defaults to `suggest`. Use your own key.

## Install

At the prompt of a terminal session:

```
/plugin install agent-chart --marketplace piclez/claude-mods
/plugin install working-on --marketplace piclez/claude-mods
```

From a shell:

```
claude plugin install agent-chart --marketplace piclez/claude-mods
claude plugin install working-on --marketplace piclez/claude-mods
```

Answer `y` to add the marketplace, then pick a scope.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with
`piclez/claude-mods`, then Add plugin.

The context bar mod lives in its own repository:

```
/plugin install context-bar --marketplace piclez/claude-context-bar
```

## Develop

```
claude --plugin-dir /path/to/claude-mods/working-on
claude plugin test /path/to/claude-mods/working-on
```

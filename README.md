# tryretool/skills

Retool's plugin marketplace for [Claude Code](https://docs.claude.com/en/docs/claude-code). Each plugin packages a Retool-aware skill, agent, or MCP integration that teaches Claude Code how to use Retool.

## Install

Add this marketplace inside Claude Code:

```
/plugin marketplace add tryretool/skills
```

Then install a plugin by name:

```
/plugin install <plugin-name>@tryretool-skills
```

To refresh the catalog after we publish new plugins:

```
/plugin marketplace update tryretool-skills
```

### Manual install (fallback)

If you need to run a plugin directly without going through the marketplace, clone the repo and point Claude Code at the plugin directory:

```
git clone https://github.com/tryretool/skills.git ~/src/tryretool-skills
claude --plugin-dir ~/src/tryretool-skills/plugins/<plugin-name>
```

## Available plugins

| Plugin | Status | Description |
| :----- | :----- | :---------- |
| `retool-import` | Coming soon | Import an existing React app into Retool as an R^2 app, using your Retool resources for service matching. |

## Contributing

Plugins live under `plugins/<name>/` and follow [Anthropic's plugin layout](https://docs.claude.com/en/docs/claude-code/plugins): a `.claude-plugin/plugin.json` manifest plus a `skills/<skill-name>/SKILL.md` for each model-invoked skill. Add new plugins to the `plugins` array in [`.claude-plugin/marketplace.json`](./.claude-plugin/marketplace.json), then validate with `claude plugin validate .` before opening a PR.

## License

Apache 2.0. See [LICENSE](./LICENSE).

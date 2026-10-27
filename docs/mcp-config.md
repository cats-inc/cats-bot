# MCP Configuration Guide

> Reference checked 2026-09-05. MCP is optional; this project does not require
> a running MCP server.

## Version and Host Compatibility

The protocol reference is [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28).
Its stateless core changes initialization and session handling; consult the
[release notes](https://blog.modelcontextprotocol.io/posts/2026-07-28/) before
migrating an existing integration.

Configuration syntax belongs to the host application, not to the MCP protocol.
Record the host version, server package/version, transport, and negotiated
protocol revision when testing. These snippets are configuration examples, not
evidence of a completed SDK or end-to-end compatibility test.

## Local Filesystem Server

The maintained reference package is `@modelcontextprotocol/server-filesystem`.
Use absolute allowed-directory paths. The following Claude Desktop example is
for Windows, where `npx` is launched through `cmd /c`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "cmd",
      "args": [
        "/c", "npx", "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:/Projects/my-project"
      ]
    }
  }
}
```

On macOS/Linux, use `"command": "npx"` and omit `"/c", "npx"` from args.
After selecting and testing a release, pin its package version for repeatable
installation. Configure only the directories needed for the task.

The [official filesystem README](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md)
documents supported options and host examples.

## Codex

Codex uses TOML MCP configuration. For a local server on Windows:

```toml
[mcp_servers.filesystem]
command = "cmd"
args = ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", "C:/Projects/my-project"]
```

Use the installed product's configuration scope and credential handling. See the
[official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).
Do not paste a host's JSON wrapper into another host's TOML configuration.

## Other Hosts

- Claude Desktop: see the filesystem server's documented Desktop setup.
- Cursor: use its project MCP configuration and verify the supported fields in
  the installed Cursor version.
- VS Code: its MCP configuration uses a `servers` map, not the Desktop
  `mcpServers` wrapper.

Environment-variable interpolation is host-specific. A string such as
`${GITHUB_TOKEN}` is not universally expanded by MCP itself.

## GitHub and Database Integrations

Use [GitHub's official MCP server](https://github.com/github/github-mcp-server)
for GitHub integration. Choose its documented remote or local installation and
authentication flow for your host; do not use the old `@anthropic/mcp-github`
example.

The old reference SQLite server is in
[servers-archived](https://github.com/modelcontextprotocol/servers-archived).
It is not a default recommendation for new projects. Select a maintained database
integration for the required database and access model, and verify its source
and release before adding it.

Discover servers through the [official MCP Registry](https://registry.modelcontextprotocol.io/).
A registry listing is not a security or compatibility guarantee.

## Project Configuration Record

When enabling an integration, document:

| Field | Value to record |
|-------|-----------------|
| Host | Product and installed version |
| Server | Maintainer, source, pinned package/container version |
| Transport | Local stdio or the supported remote transport |
| Protocol | Revision verified with this client/server pair |
| Access | Allowed paths, tool permissions, auth method |
| Validation | Date, command, result, and known limitations |

Keep credentials in the host's credential store or supported environment
configuration. Commit only examples with placeholders. Server configuration
and a successful discovery call do not authorize unrelated writes.

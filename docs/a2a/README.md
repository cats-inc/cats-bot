# Optional A2A Integration

This project does not include a runtime A2A integration by default. Full, versioned
Agent Card and JSON-RPC/SSE examples are available in project-bootstrap's optional
`a2a` flavor.

From a separate bootstrap checkout, add them to an existing child with:

```powershell
.\scripts\windows\Update-Project.ps1 -TargetPath "C:/Projects/your-child" -Flavors @("a2a")
```

```bash
bash scripts/linux/update-project.sh --target-path /path/to/your-child --flavors a2a
```

The updater preserves customized originals and stages review copies. Existing
current or legacy A2A examples continue to receive updates automatically; this
pointer alone does not opt a project into A2A. Review a README.md.bootstrap proposal
after adding the flavor.

See `docs/terminology.md` and `docs/mcp-config.md` to distinguish coding-agent
instructions, Agent Skills, A2A, and MCP. Adding examples does not install a server
or establish protocol conformance.

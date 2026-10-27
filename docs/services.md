# Service Registry

> This file documents all services in this project that listen on network ports.
> Keeping this up to date helps avoid port conflicts and makes onboarding easier.

## Services

<!-- TODO: Add your project's services here. One row per service. -->

| Service Name | Port | Protocol | Description | Start Command |
|--------------|------|----------|-------------|---------------|
| | | | | |

<!-- Example entries (remove when you have real entries):
| Frontend Dev Server | 5173 | TCP | Vite dev server for React app | npm run dev |
| Worker Dev Server | 8787 | TCP | wrangler dev for Cloudflare Worker | npm run dev --workspace apps/worker |
| Backend API | 8000 | TCP | FastAPI application server | uvicorn main:app |
| PostgreSQL | 5432 | TCP | Primary database | docker compose up db |
-->

## Environment Variables

Port numbers should be configurable via environment variables so developers can override defaults when needed.

<!-- TODO: List the .env variables that control port settings -->

| Variable | Default | Service | Notes |
|----------|---------|---------|-------|
| | | | |

<!-- Example entries:
| WEB_PORT | 5173 | Frontend Dev Server | Set in .env; read by vite.config |
| API_PORT | 8000 | Backend API | Set in .env |
| DB_PORT | 5432 | PostgreSQL | Set in docker-compose.yml |
-->

## Cross-Project Port Coordination

This project was created from **project-bootstrap**, which maintains a central port registry at:

```
<bootstrap-project>/docs/port-registry.md
```

**For AI agents**: When adding or changing a service port in this project:

1. **MUST** update the **Services** table above
2. **SHOULD** check the bootstrap project's `docs/port-registry.md` for conflicts with other projects
3. **SHOULD** register the new port in the bootstrap project's `docs/port-registry.md`
4. **MUST** warn the user if a port conflict is detected

---

*Last updated: <!-- Update this when making changes -->*

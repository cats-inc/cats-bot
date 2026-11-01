# Research Log

> Track external sources and findings that inform decisions.

## Index

| Document | Date | Topic | Summary |
|----------|------|-------|---------|
| [Linux input and busy retry](./2026-11-01-linux-input-and-busy-retry.md) | 2026-11-01 | Linux avatar and deferred messages | XWayland/native input acceptance, bounded conflicts and HTTP admission ownership |
| [2026-10-27-resident-bot-architecture-assessment](./2026-10-27-resident-bot-architecture-assessment.md) | 2026-10-27 | Resident bot core and Runtime boundary | Independent source-based assessment: direct Runtime dependency, global execution settings with separate conversation contexts, durable wake/work recovery, presentation isolation and proposed acceptance slices; excludes the other feasibility report from its evidence |
| [2026-10-27-standalone-living-bot-feasibility](./2026-10-27-standalone-living-bot-feasibility.md) | 2026-10-27 | Standalone living bot feasibility | Read-only survey of cats-runtime 0.6.2, cats-platform 0.11.1 and desktop-work-fleet 0.4.2; Catlas is the Guide Cat, the alive mechanics are the companion life loop (ADR-127); runtime is reusable over process + HTTP but its wakeups never send a prompt; leans toward depending on runtime directly, with the note/session mapping, shell choice and per-bot runtime cost left open for an ADR |

## Entry Template

```
Date:
Topic:
Source:
Summary:
Relevance:
Action Items:
```

---

*Last updated: 2026-10-27*

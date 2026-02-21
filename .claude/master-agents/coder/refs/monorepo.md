# Monorepo Management — Turborepo, Nx, Bazel

## Tool Selection
| Tool | Best For | Scale |
|------|----------|-------|
| Turborepo | JS/TS monorepos, simple setup, fast caching | Small-Medium |
| Nx | Large JS/TS, project boundaries, code generation | Medium-Large |
| Bazel | Polyglot, enterprise, hermetic builds | Large-Enterprise |
| pnpm workspaces | Dependency management base layer | Any (use WITH above) |

## Turborepo
```json
// turbo.json
{ "pipeline": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["build"] },
    "lint": {}
}}
```
- `npx turbo run build` — builds in dependency order with caching
- Remote caching: `npx turbo login && npx turbo link`
- Only rebuilds what changed (content hash-based)

## Nx
```bash
npx nx affected:build             # Only build what changed
npx nx graph                      # Visualize dependency graph
npx nx generate @nx/react:lib shared-ui  # Code generation
```
- Project boundaries via `tags` and `depConstraints` in `.eslintrc`
- Distributed caching with Nx Cloud
- `nx.json` for task pipeline configuration

## Bazel
- Hermetic builds: same inputs → same outputs, always
- Remote execution: distribute builds across cluster
- `BUILD.bazel` files define targets per directory
- `WORKSPACE.bazel` for external dependencies

## Shared Best Practices
- Clear project boundaries from day 1
- Consistent naming conventions across packages
- Remote caching in CI (massive speedup)
- `affected` / `changed` commands to skip unmodified packages
- Shared configs (ESLint, TSConfig, jest) in root packages
- Code ownership rules (CODEOWNERS)

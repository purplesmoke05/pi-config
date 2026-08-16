# Source and local patches

- Package: `pi-context-prune@1.3.0`
- Upstream tag: `v1.3.0`
- Upstream commit / npm `gitHead`: `7b4ac0ecb19d66150640a832432d45ad7d1815bb`
- npm integrity: `sha512-Dw+EMjfJrqTyGvb6GWeilvkPaNxU0D/4NEDcHsLSK4ye31N2Uj/Y7Kh0mtY57+FvTsHiXuIYd19zutCrRSQCNA==`
- Tarball SHA-256: `c2839f3f1aa65e5df138632fed9a15702da69216ea819d74fd2f9bf2865774e3`

The npm tarball's published source matches the tagged commit. This reviewed copy includes the runtime TypeScript and upstream documentation but omits release-only `.github/workflows/release.yml` and `scripts/release.mjs`.

## Local patches

1. Replace `@sinclair/typebox` imports/peer metadata with the repository's exact `typebox@1.2.8` runtime dependency.
2. Add a local `RuntimeModelRegistry` projection in `src/summarizer.ts`. Runtime Pi 0.84 exposes provider and resolved base-URL methods that are absent from this repository's older reproducible Pi 0.80 TypeScript baseline; the projection documents that drift without weakening project-wide types.
3. Add `tests/local-integration.test.ts` for disabled defaults, summarizer thinking mapping, selective context pruning, and recovery-tool registration.

No pruning, summarization, persistence, or recovery behavior is otherwise changed.

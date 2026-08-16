# Source and local review files

- Package: `pi-cache-optimizer@2.8.2`
- npm `gitHead`: `dfa60b2c3e92f4a15363664c546d2042bded0b3f`
- npm integrity: `sha512-z5Ff2ZUF+U4O3gpV/uKTvO5046Zx/km1nDAw22b1GUKb8yslDAo1EZMlxTFTex9XGsmg/MVEt3FRmmpNNlpWvQ==`
- Tarball SHA-256: `41eea15faef8a70ce7cb50999a3bdd4016d65435d274b883c205f0332cc420cf`

The published runtime (`index.ts`), package metadata, README files, and license are byte-identical to the npm tarball. The upstream repository did not expose the release tag through `git ls-remote` during this review, so npm `gitHead` and tarball hashes are the reproducible source boundary.

## Local review additions

- `tests/review-findings.test.ts` exercises stable-prompt movement, footer status ownership, completion, statistics modes, adaptive-thinking compatibility, config precedence, JSONC repair, and the explicit `/cache-optimizer fix` path.
- `types/pi-coding-agent.d.ts` supplies the narrow Pi surface used by those tests.
- `tsconfig.json` provides the package-local compatibility typecheck.

The runtime source itself is unmodified. The package has no runtime dependencies, optional dependencies, install scripts, direct network client, telemetry, or subprocess launch. Normal operation writes only optimizer statistics/config under Pi's agent directory. Editing `models.json` is restricted to the explicit `/cache-optimizer fix` command after a preview and confirmation, with a timestamped backup.

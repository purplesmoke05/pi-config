# Runtime authoring

Use this page for routine scripts. Open the generated capability index only when a signature, default, support boundary, or installed-version fact is missing here.

## Script envelope

Start with the only legal export: `export const meta = { name, description, phases?: [{ title, detail?, model? }] }`. Values are nonblank literals; declare only used phases and call `phase()` before each phase's work. The remaining body already runs inside an async function: write helpers as ordinary declarations; `export default` and other exports are invalid. Return the result explicitly.

The supported runtime supplies `agent`, `parallel`, `pipeline`, quality/control helpers, `phase`, `log`, `args`, `cwd`, restricted `process.cwd()`, and `budget`. Imports, `require()`, filesystem modules, `Date.now()`, `Math.random()`, and no-argument `new Date()` are unavailable. The Node VM realm is implementation substrate, not a security boundary or public API. Raw, saved, and resumed custom scripts are therefore shown in full and require an explicit human confirmation before each top-level execution; headless execution and unattended custom-code resume fail closed. Curated built-ins do not require this confirmation. A low-level compatibility binding named `workflow` may exist, but the audited Pi host rejects every in-script call because child code is not part of the approved top-level script; keep child phases and agent calls inline.

## Topology

- `parallel()` takes thunks, runs independent work, and preserves input order. Await the whole array before whole-set synthesis.
- `pipeline()` runs stages sequentially per item while items proceed concurrently. Each stage receives `(previousValue, originalItem, index)` and forwards `null` to the next stage, so guard missing coverage first.
- Do not call `workflow(...)` inside a script. The audited Pi host rejects every nested child route; keep all executable child logic directly visible in the one approved top-level script.

## Data and failure

Call `agent(prompt, { label, schema? })`; it returns text, a schema-validated value, or recoverable `null`. Nonrecoverable limit, validation, and budget failures throw. Record each intended work ID before filtering. A `null` means missing coverage, never a negative finding.

When JavaScript reads fields, pass a small plain JSON Schema. Schema noncompliance after repair throws and bypasses agent retries. Catch it only to return an explicit incomplete outcome without reading missing fields. Return objects, arrays, strings, numbers, booleans, and `null`—not functions, promises, cycles, `BigInt`, or runtime handles.

## Routing and support

Selector priority is explicit `model` > `agentType` model > `tier` > phase model > metadata model > implicit `medium` > session default. An unavailable EXPLICIT selector (`model`, `agentType` model, `tier`, or phase model) throws instead of falling back — catch it if the script needs to degrade gracefully. Only the implicit default `medium` tier an untagged agent falls into degrades to the session default when unavailable, with a one-time warning logged into the run. Use exact `model`, nonstandard `tier`, or `agentType` only when context supplies its name and purpose. Requested worktree isolation is mandatory; setup failure stops the agent call. See [registry ownership](registry-ownership.md).

Generated entries marked `supported` are authoring API. `console` and whole-script Markdown fences are compatibility-only. VM realm facilities are internal. Active model routes and agent types are dynamic. Use `log()` in new scripts.

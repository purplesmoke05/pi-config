export const meta = {
  name: "single_script_child_jobs",
  description: "Run bounded child jobs sequentially inside one approved workflow script",
  phases: [{ title: "Prepare" }, { title: "Run child jobs" }],
};

const jobs = args && Array.isArray(args.jobs) ? args.jobs.slice(0, 8) : [{ id: "sample" }];
const preparationSchema = {
  type: "object",
  properties: { ready: { type: "boolean" } },
  required: ["ready"],
};

phase("Prepare");
const preparation = await agent(`Check ${jobs.length} bounded child jobs for readiness.`, {
  label: "prepare-child-jobs",
  schema: preparationSchema,
});
const preparationMissing = preparation === null;

phase("Run child jobs");
const childResults = [];
if (preparationMissing || !preparation.ready) {
  for (const job of jobs) childResults.push({ id: String(job.id), status: "missing", result: null });
}
for (const job of preparationMissing || !preparation.ready ? [] : jobs) {
  const id = String(job.id);
  // INVARIANT: keep every executable child step directly visible in this approved script.
  const result = await agent(`child:${id}`, { label: `child:${id}` });
  const missing = result === null;
  childResults.push({ id, status: missing ? "missing" : "complete", result });
}
const missing = childResults.filter((entry) => entry.status === "missing").map((entry) => entry.id);

return {
  preparation: { status: preparationMissing ? "missing" : "complete", result: preparation },
  childResults,
  missing,
  complete: !preparationMissing && missing.length === 0,
};

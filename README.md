# SparkBench

Measured token throughput from a personal NVIDIA DGX Spark, with model format, inference engine, precision, latency, per-trial statistics and a published protocol.

This is a read-only snapshot of the benchmark performed on 28 September 2026. It contains 26 model entries, 25 successful entries including one embedding model, and one incomplete checkpoint. Aliases remain individually measured and can be grouped in the interface. The dashboard displays medians; the full report also includes means and observed ranges.

Qwen3.8-Flash-Next on TensorFold was measured on 29 September 2026 against the server that was already loaded.

Ollama uses engine generation duration. vLLM uses client-observed stream timing. Server configurations differ; measurements are not answer-quality rankings or a controlled engine comparison. GPT-OSS output counts include returned reasoning. Gemma 4 31B uses an explicitly recorded temporary vLLM runtime patch. The Qwen3.5 122B checkpoint is incomplete and has no speed claim.

The supplemental workload archive adds coding, chat and variable-context prefill observations. Each result carries its workload, model, engine, timing basis, protocol and source. Results from different prompts or sampling settings are kept as separate observations. Missing measurements are shown as unmeasured. Generation speed is not a coding-correctness or writing-quality score.

The public data export excludes private host paths, process commands, environment variables, prompt and response text. The full raw evidence, SQLite history and runnable benchmark protocol remain on the Spark.

## Hosting

Plain HTML, CSS and JavaScript plus `data.json`, `summary.json`, and `workloads.json`. GitHub Pages publishes the main branch root. The `CNAME` is `sparkbench.lexilominite.com`. No inference endpoint is exposed by this site.

The interface provides workload-specific tables, search and engine filters, model comparisons, alias grouping, individual trial details, serving configuration, memory and power observations, and long-context prefill. JSON and CSV exports preserve measurement provenance.

## Updating results

Run the private benchmark launcher on Spark, verify its stored results, export a new curated `data.json`, and commit the reviewed snapshot. Refresh in the public UI reloads the published snapshot; it does not initiate a benchmark or query a private machine.

The historical writing baseline stays in `data.json` and `summary.json`. Supplemental and newly measured workload results stay in `workloads.json`. See [WORKLOADS.md](WORKLOADS.md) for the workload schema and comparability rules.

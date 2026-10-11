# SparkBench

How fast local language models generate on one NVIDIA DGX Spark (GB10, 128 GB unified memory), with the format, engine, precision, latency, every trial and the protocol behind each number. Live at [sparkbench.lexilominite.com](https://sparkbench.lexilominite.com).

The site has six views:

- **Leaderboard**: a live "token tape" that types a 512-token answer at each setup's measured speed, then the full table of writing, coding and chat results with filters, grouping, selection and CSV export.
- **Speed map**: output speed against weight size on log scales, with the 273 GB/s memory-bandwidth ceiling for a dense model. Mixture-of-experts models and speculative decoding are the points above it.
- **Long prompts**: prompt-processing speed from 1k to 115k tokens, and how long a 115k-token prompt takes to read.
- **Studies**: a dated record of what was tested, including the 11 October NVFP4 against MLX 4-bit study on TensorFold.
- **Compare** and per-setup pages with trials, protocols, start-up observations and resources.
- **Method**: hardware, timing formulas and limits.

The original writing snapshot from 28 September 2026 contains 26 model entries, 25 successful entries including one embedding model, and one incomplete checkpoint. Later additions bring the inventory to 32 model and engine setups: the Qwen3.8 Flash Next TensorFold server (29 September), full-BF16 and unsupported TensorFold configurations (30 September) and three TensorFold 0.6.6 setups from the 11 October quantization study. Aliases remain individually measured and can be grouped in the interface. The dashboard displays medians; the full report also includes means and observed ranges.

Ollama uses engine generation duration. vLLM uses client-observed stream timing. TensorFold reports its own decode timing. Server configurations differ; measurements are not answer-quality rankings or a controlled engine comparison. GPT-OSS output counts include returned reasoning. Gemma 4 31B uses an explicitly recorded temporary vLLM runtime patch. The Qwen3.5 122B checkpoint is incomplete and has no speed claim.

The 30 September controlled coding/chat suite completed all 54 mapped profiles: 45 successful, three failed and six unavailable. The 11 October study adds 512-token coding and chat decode, four-stream throughput, cold prefill from about 7k to 115k tokens, a long-prompt recall check and a tool-call check for four TensorFold setups. Each result carries its workload, model, engine, timing basis, protocol and source. Results from different prompts or sampling settings are kept as separate observations. Missing measurements are shown as unmeasured. Generation speed is not a coding-correctness or writing-quality score.

The public data export excludes private host paths, process commands, environment variables, credentials, and prompt and response text. The full raw evidence, SQLite history and runnable benchmark protocol remain on the Spark.

## Hosting

Plain HTML, CSS and JavaScript (`index.html`, `assets/app.css`, `assets/app.js`) plus `data.json`, `summary.json`, and `workloads.json`. The look follows the LexiLominite "Terminal Noir" family: a console register by default (teal-black, cyan traces, signal yellow) and a paper register for light reading, with an oscilloscope graticule as SparkBench's own motif. Orbitron, Electrolize and Inter are self-hosted under `assets/fonts` (SIL Open Font License), so the site makes no third-party requests. Layouts add columns on wide and ultrawide screens: from 2200 px the scope stays pinned beside the leaderboard. GitHub Pages publishes the main branch root. The `CNAME` is `sparkbench.lexilominite.com`. No inference endpoint is exposed by this site.

The interface compares writing, coding and chat rates side by side, with optional single-workload views. Search and advanced filters cover total/active parameter count, weight size on disk, engine, format and quantization. Model selections, alias grouping, individual trials, serving configuration, memory/power observations and long-context prefill remain available. JSON and CSV exports preserve measurement provenance. First-party preference cookies remember the chosen view, filters, sort and selected models; users can disable or clear that saved state.

## Updating results

Run the private benchmark launcher on Spark, verify its stored results, export a new curated `data.json`, and commit the reviewed snapshot. Refresh in the public UI reloads the published snapshot; it does not initiate a benchmark or query a private machine.

The historical writing baseline stays in `data.json` and `summary.json`. Supplemental and newly measured workload results stay in `workloads.json`. See [WORKLOADS.md](WORKLOADS.md) for the workload schema and comparability rules.

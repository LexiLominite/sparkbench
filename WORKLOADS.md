# SparkBench workload measurements

The workload selector changes the measured task. Writing, coding and chat rates are separate observations; the dashboard does not infer one task's speed from another. None of these rates measure answer quality, code correctness or task success.

## Original writing baseline

The writing view preserves the essay-prompt benchmark in `data.json` and `summary.json`: a 16-token warmup followed by three measured requests capped at 256 output tokens, temperature 0, seed 20260928, thinking off where supported, and one request at a time. The warmup is excluded from medians. Different tokenizers, server profiles and engine timing formulas remain visible in the protocol and model details. GPT-OSS's generated-token count includes returned reasoning.

Qwen3.8-Flash-Next's writing result remains 55.92205863078335 tokens/s with 0.47179022495402023 seconds to first token. The TensorFold server was already loaded for these trials.

## Supplemental measurements

The archived TensorFold coding observation is a reported 69.9 tokens/s median under greedy decoding. Its sampled-chat observation is 58.0 tokens/s. These use different prompts from the writing benchmark. The curated source does not retain the sample count, output length, exact chat temperature or per-trial timing, so those fields remain unknown. They are secondary measurements, preserved separately from new controlled workload trials.

Four separate prefill observations cover 860, 3,211, 12,638 and 50,308 prompt tokens. Their reported prefill rates are 1,633, 2,152, 2,421 and 2,335 tokens/s, with first-token times of 0.53, 1.50, 5.25 and 21.64 seconds. These rounded observations do not establish an uncached long-context ranking across all models.

## Controlled coding and chat suite

The new suite has protocol ID `sparkbench-workloads-v1`. Models run sequentially with one request at a time. Each workload receives a 16-token warmup and three measured requests capped at 256 generated tokens, temperature 0, seed 20260928, and thinking disabled where supported. A record includes its exact engine, format, quantization, model identity, prompt hashes, token counts, timing basis and server settings. Early end-of-sequence can produce fewer than 256 output tokens; actual token counts and trial durations are retained.

Raw prompt/response evidence, runner code, run protocol and per-trial checkpoints are kept privately on Spark. The public archive contains allowlisted measurements and prompt hashes. A model load failure, changed checkpoint, missing shard or unsupported workload is recorded without inventing a speed. Alias measurements retain their own attribution unless a shared result is explicitly labeled.

Ollama decode uses engine output-token count divided by engine decode duration. OpenAI-compatible streaming engines use the recorded engine timing fields when available, otherwise explicitly labeled client stream timing. MTP accepted tokens, reasoning tokens and prompt-cache effects must be identified on each applicable result. Cross-engine numeric comparisons include these differences.

## Archive schema

`workloads.json` is a versioned archive with `profiles`, `results`, `long_context`, and `startup_observations` arrays. A workload result identifies `model_id`, `model_name`, `engine`, `workload`, `status`, `trial_count`, numeric `metrics`, safe `trials`, `protocol`, and `provenance`. A `preferred` record selects the new controlled observation without deleting older supplemental evidence. Statistics include median, mean, observed minimum and maximum, sample standard deviation and variation when individual trials are available.

First-token latency, input prefill, end-to-end rate and startup observations represent different parts of inference. Model memory and host memory are also different measurements. Board power and temperature are short samples, not wall power or long-duration thermal stability. Model details explain the relevant basis rather than treating these values as interchangeable.

The public site is a published snapshot. Refresh reloads this archive and does not start an inference request on Spark.

## Completed 30 September coding/chat release

The controlled suite completed all 54 mapped profiles: 45 successful three-trial measurements, three failed chat profiles, and six unavailable profiles. The Qwen3.6 35B base, fast and agent chat runs each encountered a CUDA illegal-memory-access error in the installed Ollama runtime; their successful coding measurements are retained. The unavailable profiles cover the embedding model, incomplete 122B checkpoint and the Flash NVFP4 checkpoint unsupported by the installed vLLM build. Separate TensorFold compatibility checks add four unavailable coding/chat observations for the BF16 and mixed NVFP4 configurations, outside the 54-profile suite. Two earlier rounded TensorFold observations remain archived separately.

Native Ollama timing fields retain engine durations in nanoseconds, together with engine prompt/output counts. The interface converts durations to seconds for display. These fields supplement the unchanged decode median and client first-token latency; they do not replace either formula.

Startup observations identify the model and engine. vLLM startup-to-observed-ready covers the launch request through the first successful readiness observation, before warmup, with readiness polled every five seconds. This includes launch, initialization, weight loading and any compilation or tuning, and is not a pure disk-transfer rate. Native weight-loading seconds and weight allocation GiB come from engine logs and use a separate window. Ollama's first coding warmup after explicit unload records its native load duration. Already loaded services and unsupported checkpoints have no new startup measurement. Null values mean not measured, not zero.

The final private runner receipt verifies restoration of the same BF16 container object and its original configuration, a successful inference smoke request, no temporary benchmark inference container, no loaded Ollama models, and release of the shared inference-maintenance lock. Raw prompts and response text remain private on Spark.

## 11 October TensorFold quantization study

Protocol ID `tensorfold-quant-study-20261011`, schema version 2. One bench client ran against each server in turn: the live Qwen3.8 Flash Next MLX 4-bit server (TensorFold 0.3.6.3), then Qwen3.8 27B NVFP4, Qwen3.8 27B MLX 4-bit and Qwen3.8 Flash Next NVFP4 (QAD), each on TensorFold 0.6.6. Requests were greedy (temperature 0, seed 7) with thinking off and a 512-token output limit. Coding and chat each ran three requests; the first also warms the prefix cache and is included in the median. Speculative decoding stayed on as each server is normally configured (MTP for Flash Next, the DFlash2 drafter for the 27B), so decode rates depend on draft acceptance.

The study also records four simultaneous coding requests (aggregate completion tokens over wall time), cold prefill with prompts of about 7k, 28k and 115k tokens (aimed at 8k, 32k and 128k, which the CSV column names keep; Python standard-library source with a unique first line, one request per size), a passphrase recall from the start of a ~104k-token prompt and one tool call. The recall and tool checks are pass/fail functional checks, not quality scores.

Decode medians are the values recorded by the bench client from each response's `decode_tps`. Per-request rates, first-token times and accepted drafts come from each server's log; TensorFold rounds its logged rate slightly differently, so those statistics are published separately as `decode_tps_server_log`. The live 0.3.6.3 server did not log per-request lines, so its four results carry medians only. The Flash Next pair also differs in engine version, server streams (5 against 4) and vision, so it is not a pure format comparison. These results are kept apart from the 30 September suite: the prompts and output limit differ, and the already published Flash Next keeps its controlled-suite numbers as preferred.

Schema version 2 adds these arrays to `workloads.json`:

- `configurations`: engine setups that have no writing baseline (`writing_baseline: false`), with checkpoint repository and revision, weight size, and the server settings used.
- `concurrency`: aggregate throughput for simultaneous streams, with per-stream rates where logged.
- `checks`: functional pass/fail checks tied to a study.
- `studies`: a question, its short answer, the compared setups and pairs, findings, caveats and outcome.
- `timeline`: dated entries for each addition to the archive.

Long-context rows from the study carry `prefill_s` and a `size_label`. Prompt text is published only as SHA-256 hashes. The flat `quant-study-20261011.csv` repeats the headline numbers.

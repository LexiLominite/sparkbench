# SparkBench study ledger

SparkBench separates controlled benchmark results from smoke qualifications, live operational observations and design reviews. A number on the Studies page is only as strong as the evidence class printed beside it. Historical acceptance proves what passed at that time; it does not silently become proof of current runtime state.

Public study records omit prompts and replies, credentials, private endpoints, host paths, process command lines and raw environment data. Exact public checkpoint revisions, runtime releases, measurements, protocol settings and evidence limitations are retained when they are necessary to interpret a result.

## 3 October 2026 — real harness acceptance

**Evidence class:** real-client acceptance, recorded at the time of the repair.

The question was whether a TensorFold-served EXL3 checkpoint was incompatible with Claude Code. The failure occurred before model generation: a simple OpenAI-style tool probe did not exercise the Anthropic Messages stream, in-conversation system-message shape, fragmented tool JSON, tool-result consumption or disconnect behavior used by the real client. Nine historical coding attempts failed before generation.

The acceptance bar was therefore raised from “one request returned” to a complete coding-agent loop. The repaired route was exercised through the real Claude Code client on LexBook and LexAssist; the clients had to make multiple tool calls, consume tool results, finish streaming, leave an independently checkable artifact and release request admission cleanly. The exact checkpoint was preserved.

This is strong historical integration evidence, but not a present-tense service-health claim. Full-context and full-output stress were outside the acceptance envelope.

## 4 October 2026 — explicit KV-cache reservation

**Evidence class:** read-only inspection of one live vLLM 0.24.0 worker.

The inspected Qwen3.8 27B NVFP4 worker reported about 104.5 GiB of engine allocation. Its launch profile explicitly assigned 82,978,768,158 bytes—about 77.28 GiB—to KV cache. vLLM reported 1,614 cache blocks, about 1.25 million token capacity and roughly 4.775 full 262,144-token requests of theoretical concurrency. The checkpoint files were about 20.4 GiB.

Only about 3.84% of cache blocks were occupied at the sampled moment, but the cache was physically preallocated. The study therefore attributes most of the large footprint to an explicit serving choice, not to the parameter count or an observed leak. No setting, service or worker was changed.

## 8 October 2026 — vLLM 0.31.0 smoke qualification

**Evidence class:** isolated compatibility smoke test, not a benchmark.

The official ARM64 vLLM 0.31.0 image was identified by immutable digest and probed on GB10. Two installed checkpoints—NVIDIA Qwen3.8 27B NVFP4 and a Qwen3.8 27B block-FP8 build—were started sequentially in localhost-only staging containers with offline weights, 2,048-token context, one sequence and an explicit 1 GiB KV cache.

Both loaded, returned the requested arithmetic answer, produced a forced function call with valid JSON arguments and returned HTTP 401 without authentication. Temporary containers were removed. The test did not cover performance, maximum context, vision, concurrent serving, automatic tool choice or a coding harness.

## 8 October 2026 — TensorFold version comparison

**Evidence class:** matched single-pass baseline/candidate comparison.

TensorFold 0.3.6.3 and 0.6.6 used the same cached `Vontra/Qwen3.8-Flash-Next-MLX-4bit-MTP` revision, mounted read-only and offline. Context, parallelism, INT8 KV cache, PLE, MTP depth and confidence, thinking, temperature and seed were matched. Candidate compiler state was isolated.

At 8,120, 32,696, 131,000 and 261,048 input tokens, both versions returned the same correct eight-token answer and token hash. Elapsed times for 0.3.6.3/0.6.6 were 3.43/3.55, 13.81/13.83, 62.96/62.35 and 144.04/138.05 seconds. Each length ran once, so the near-limit difference is an observation rather than a general speed claim.

The matched 192-token LRU coding request behaved differently: 0.3.6.3 finished in 165 tokens and passed five of five functional checks; 0.6.6 reached the output limit inside the implementation and passed one of five. One prompt cannot establish a general quality regression, but it did disprove behavioral equivalence within the tested envelope. The original runtime was restored and the candidate was not promoted.

## 11 October 2026 — TensorFold quantization study

**Evidence class:** controlled local benchmark with a public flat CSV and structured JSON archive.

The full protocol is in [WORKLOADS.md](WORKLOADS.md#11-october-tensorfold-quantization-study), and the headline results are in [quant-study-20261011.csv](quant-study-20261011.csv). The comparison covers coding and chat decode, four simultaneous coding streams, cold prefill at three prompt lengths, long-prompt recall and a tool-call check for two dense 27B builds and two Flash Next builds.

The main interpretation remains deliberately narrow: dense 27B NVFP4 improved prompt processing while MLX 4-bit decoded faster; the Flash Next NVFP4 build trailed the then-live MLX 4-bit server. The Flash pair used different TensorFold versions and is not a pure weight-format experiment. Quality was not scored.

## 12 October 2026 — long-context cache and contention

**Evidence class:** point-in-time operational logs, not a randomized benchmark.

The user-visible dashboard showed about four tokens per second while three long requests were active. Recent logs separated two mostly cached requests from three uncached requests of roughly the same 69k–73k prompt size. The cached cases reused 67.1k of 68.7k and 72.4k of 72.8k prompt tokens, reached first output in 2.57 and 0.63 seconds and reported 58.1 and 46.4 wall-clock tokens per second. The uncached cases reported first output from 53.73 to 112.15 seconds and 3.4–3.6 wall-clock tokens per second.

The displayed rate divided completion tokens by total request latency; it therefore combined queueing, prompt processing and decode. The diagnosis established the role of prefix reuse and concurrent prefill, but not why similar requests alternated between almost complete reuse and zero reuse. No scheduler setting or model was changed. A proper follow-up should hold prompt bytes and request timing fixed while comparing one versus concurrent, cached versus uncached 72k-token requests.

A 15 October follow-up separated a request's own generation rate from the engine's combined token counter. One live two-stream reading showed roughly 55 tok/s per request and about 100 tok/s together. It is useful confirmation that per-request and aggregate speed answer different questions, but it remains one live reading rather than a controlled throughput series.

## 14 October 2026 — measurement control-plane review

**Evidence class:** source/runtime architecture review plus incomplete implementation evidence.

The served Spark Control v2 release was matched byte for byte against its owning source checkout for 84 backend/package files, and the deployed JavaScript asset matched the local build. The review then identified three prerequisites for trustworthy multi-app measurement:

1. request context must begin before autoload and retain a privacy-bounded timeline through queue, model load, upstream connection, first output, completion, retry, error and disconnect;
2. inference scheduling needs real app identity, but 16,598 of 16,754 requests in the observed seven-day Usage view—about 99.1%—used one shared `Default` key;
3. runtime qualification needs immutable checkpoint/runtime/profile/suite fingerprints, cold/warm labels, exclusive inference reservation, stale-result invalidation, recovery manifests and verified rollback.

These conclusions do not prove the proposed Request Inspector, fair scheduler or Qualification Lab is deployed. Twelve Request Inspector tests passed through the correct discovery path, but the wider workload suite, frontend build, browser E2E, production cutover and rollback verification were incomplete in the recorded work. The Studies page preserves that boundary explicitly.

## 14 October 2026 — whole-uptime power estimate

**Evidence class:** GPU-sensor-backed estimate with an explicit system allowance; no wall meter.

Boot history recorded 2,107 powered-on hours across 20 boots from 18 July through 14 October. The 319 hours covered by retained power monitoring averaged about 33 W for the box when the GPU sensor was combined with a fixed 12 W allowance for the rest of the system and a 25 W floor. The remaining 1,788 hours were extrapolated at that monitored average, producing an all-time estimate of about 70.3 kWh and roughly ₹408 at the saved ₹5.80/kWh tariff.

This is an estimate, not a utility-grade measurement. The Spark exposes a GPU power sensor, not wall-socket draw; the 12 W non-GPU allowance must be replaced by a plug-in meter to validate total-system energy. July through September may also be understated because the machine could have spent time on an earlier, higher-idle-power software state. The downloadable CSV retains the all-time, 30-day and seven-day estimates and their assumptions.

## Source hierarchy

For runtime and checkpoint behavior, SparkBench links to the upstream release, official documentation or primary model card. For local observations, the public study entry is a sanitized evidence summary derived from the retained private receipt. Private receipts are not published because they can contain machine paths, request bodies, generated output, process details or access material.

When an upstream claim and a local observation answer different questions, both are kept: upstream compatibility or benchmark tables do not replace a matched local test, and a single local incident does not become a general statement about every runtime.

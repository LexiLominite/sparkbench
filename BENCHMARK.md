# DGX Spark measured model throughput

Benchmark date: 28 September 2026. Hardware: NVIDIA GB10, approximately 121.69 GiB OS-visible unified memory. Ollama 0.32.14; vLLM 0.24.0. Driver 580.178.04; driver-reported CUDA 13.0.

Coverage: 25 entries, 24 successful including one embedding model, one incomplete checkpoint. Each successful generation entry received a 16-token warmup and three measured 256-token requests. Inference models were run sequentially. Temperature 0, seed 20260928, thinking disabled where supported.

These tables show arithmetic means and observed ranges. The interactive dashboard shows medians. This is throughput evidence, not an answer-quality ranking.

## Generation results

| Model / installed tag | Engine | Format | Mean output tok/s | Observed range | Sample SD | Mean first-token s |
|---|---|---|---:|---:|---:|---:|
| `qwen3:0.6b-q4_K_M` | Ollama | gguf | 276.37 | 274.11–278.46 | 2.181 | 0.215 |
| `agent:qwen3.6-35b-a3b-q4_K_M` | Ollama | gguf | 73.11 | 72.99–73.24 | 0.126 | 0.737 |
| `qwen3.6:35b-a3b-q4_K_M` | Ollama | gguf | 72.48 | 71.59–73.04 | 0.780 | 0.722 |
| `fast:qwen3.6-35b-a3b-q4_K_M` | Ollama | gguf | 71.06 | 69.02–72.35 | 1.784 | 0.715 |
| `gemma4:26b` | Ollama | gguf | 70.52 | 69.47–71.53 | 1.032 | 0.786 |
| `gpt-oss:120b-a5.1b-mxfp4` | Ollama | gguf | 42.74 | 42.02–43.33 | 0.663 | 0.923 |
| `nvidia_Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4` | vLLM | safetensors | 35.36 | 35.04–35.62 | 0.292 | 0.173 |
| `qwythos:9b-v2-q8_0` | Ollama | gguf | 26.51 | 26.40–26.70 | 0.164 | 0.675 |
| `gemma4:12b-q4_K_M` | Ollama | gguf | 26.50 | 26.45–26.58 | 0.065 | 0.954 |
| `reasoning:qwen3.8-27b-q4_K_M` | Ollama | gguf | 23.42 | 23.00–24.05 | 0.561 | 1.503 |
| `coder:qwen3.8-27b-q4_K_M` | Ollama | gguf | 23.32 | 22.87–23.99 | 0.596 | 1.509 |
| `qwen3.8:27b-q4_K_M` | Ollama | gguf | 23.25 | 22.90–23.80 | 0.479 | 1.527 |
| `vision:qwen3.8-27b-q4_K_M` | Ollama | gguf | 23.20 | 22.88–23.73 | 0.461 | 1.478 |
| `default:qwen3.8-27b-q4_K_M` | Ollama | gguf | 23.19 | 22.82–23.79 | 0.523 | 1.513 |
| `nvidia_NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` | vLLM | safetensors | 14.95 | 14.79–15.03 | 0.137 | 0.651 |
| `falak-orion:30.7b-q4_K_M` | Ollama | gguf | 10.50 | 10.46–10.52 | 0.030 | 1.954 |
| `falak-orion-tools:30.7b-q4_K_M` | Ollama | gguf | 10.49 | 10.47–10.51 | 0.025 | 1.842 |
| `Qwen3.8-27B-Uncensored` | vLLM | safetensors | 8.36 | 8.32–8.42 | 0.054 | 0.442 |
| `nvidia_Gemma-4-31B-IT-NVFP4` | vLLM (patched) | safetensors | 6.64 | 6.54–6.79 | 0.130 | 0.575 |
| `trendyol-cyber:32.8b-q8_0` | Ollama | gguf | 6.64 | 6.63–6.64 | 0.006 | 1.221 |
| `trendyol-cyber-tools:32.8b-q8_0` | Ollama | gguf | 6.59 | 6.53–6.63 | 0.057 | 1.210 |
| `ThreatMon-qwen36-secura` | vLLM | safetensors | 4.33 | 4.31–4.34 | 0.016 | 1.004 |
| `Qwen3.8-27B-BF16` | vLLM | safetensors | 4.32 | 4.29–4.33 | 0.024 | 1.008 |

## Embeddings

`qwen3-embedding:8b-q4_K_M`: mean 2003.57 input tokens/sec across three requests. This whole-request input rate is separate from generation output rate.

## Measurement and coverage limits

- Ollama output rate is eval_count divided by engine generation duration. vLLM output rate is completion tokens minus one divided by the interval between first and last content chunks. These formulas differ.
- Ollama requests used context 8192 with its existing four parallel server slots and Q8_0 KV cache. The existing FP8 vLLM server kept context 262144, eight maximum sequences, FP8 KV and memory utilization 0.90. Additional vLLM models used eager execution, context 8192, one sequence and memory utilization 0.80. Full profiles are in data.json and summary.json.
- Prefix caching was enabled; filesystem caches were not cleared. Load observations are not guaranteed cold-disk times. Shared prompt/tokenizer/template differences affect prefill and first-token measurements.
- GPT-OSS returned reasoning despite the request to disable it; its generated-token rate includes reasoning.
- Gemma 4 31B originally failed in stock vLLM. Its recorded successful run uses a temporary tied-unquantized-LM-head patch. The checkpoint and base image were preserved; hashes and the original failure are recorded.
- Qwen3.5-122B-A10B-NVFP4 is missing two of nine shards and has no throughput claim.
- Image/video diffusion weights and auxiliary encoders are excluded from text token throughput. Some protected filesystem directories were not accessible.
- Sampled memory is host total minus MemAvailable and includes other host processes. GPU power is a board sample, not wall power. Three short trials do not establish long-duration thermal stability.
- The public site is a read-only snapshot. Full raw evidence, request/response text, service checks and SQLite history remain on Spark.

## Official Qwen3.8 27B BF16

Source: [Qwen/Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B), revision `1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0`. All 18 weight shards and 19 LFS objects passed hash verification. All 1199 tensors are BF16, totaling 27,781,427,952 stored parameters including vision/auxiliary tensors; no quantization configuration. Repository assets total 55,586,114,863 bytes. The model ran successfully in unpatched vLLM and was unloaded after measurement.

Statistics: [summary.json](summary.json). Dashboard dataset: [data.json](data.json).

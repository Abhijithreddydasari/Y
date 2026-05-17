# models/

Ollama Modelfile manifests for Y. The actual GGUF/safetensors artefacts are
gitignored — pull them from Hugging Face or rebuild via the Unsloth notebook.

| File | Role | Source artefact |
|---|---|---|
| `Modelfile.y-gemma4` | Edge fine-tuned tutor (`y-gemma4`) | `y-gemma3n-svg-q4_k_m.gguf` from `training/unsloth_train.ipynb` (step 8) |

## Building the fine-tuned model locally

```powershell
# Copy the GGUF out of Kaggle (or `huggingface-cli download yourname/y-gemma3n-svg-gguf` once published).
# Drop it next to the Modelfile:
#   models/y-gemma3n-svg-q4_k_m.gguf
ollama create y-gemma4 -f models/Modelfile.y-gemma4
ollama run  y-gemma4 "Test"
```

The host backend will pick up `y-gemma4` automatically when the toolbar's
"Edge fine-tuned (E2B+LoRA)" model is selected.

If GGUF conversion fails (Gemma-3n is still maturing inside `llama.cpp`),
fall back to the base E2B by editing the `FROM` line to `FROM gemma3n:e2b`.
The Unsloth track deliverable in that case is the LoRA on HF + this
Modelfile + the Kaggle notebook — judges only need to be able to *run* the
training pipeline; serving the merged weights through Ollama is a bonus.

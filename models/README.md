# models/

Ollama Modelfile manifests for Y. The actual GGUF/safetensors artefacts are
gitignored — pull them from Hugging Face or rebuild via the Unsloth notebook.

| File | Role | Source artefact |
|---|---|---|
| `Modelfile.y-gemma4` | Edge fine-tuned tutor (`y-gemma4`) | `y-gemma4-svg-q4_k_m.gguf` from `training/unsloth-training.ipynb` |

## Building the fine-tuned model locally

```powershell
# Copy the GGUF out of Kaggle or download it from the published Hugging Face artifact.
# Drop it next to the Modelfile:
#   models/y-gemma4-svg-q4_k_m.gguf
ollama create y-gemma4 -f models/Modelfile.y-gemma4
ollama run  y-gemma4 "Test"
```

The host backend will pick up `y-gemma4` automatically when the toolbar's
"Edge fine-tuned (E4B+LoRA)" model is selected.

If the GGUF export from the Unsloth notebook fails on your machine,
fall back to the base Gemma 4 E4B by editing the `FROM` line in the
Modelfile to `FROM gemma4:e4b`. The Unsloth track deliverable in that
case is the LoRA on HF + this Modelfile + the Kaggle notebook — judges
only need to be able to *run* the training pipeline; serving the merged
weights through Ollama is a bonus.

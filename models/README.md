# models/

Ollama Modelfile manifests for Y. The actual GGUF/safetensors artefacts are
gitignored — pull them from Hugging Face or rebuild via the Unsloth notebook.

| File | Role | Source artefact |
|---|---|---|
| `learner-adapter-v1.safetensors` | Shared 9.43M learner model | `deploy/modal_train_learner.py` |
| `learner-adapter-v1.config.json` | Architecture, validation loss, and hashes | emitted beside the checkpoint |
| `Modelfile.y-gemma4` | Edge fine-tuned tutor (`y-gemma4`) | `y-gemma4-svg-q4_k_m.gguf` from `training/unsloth-training.ipynb` |

The learner-adapter checkpoint is intentionally distinct from Gemma. Fast
weights are never stored here; they live under each learner's data directory.
`GET /health` says `trained_checkpoint: false` until this file is present.

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

# Credits & Attributions

Open Design ships with curated content adapted from public, openly licensed
prompt libraries. This file gives appropriate credit per CC BY 4.0 and
documents the upstream sources so contributors can verify the data
themselves.

If you are an upstream author and want a prompt removed, edited, or
re-attributed, please open an issue — we'll act fast.

---

## Curated prompt templates

The Image templates and Video templates galleries (and the prompt-template
picker in the new-project panel) ship a hand-curated subset of prompts
adapted from the following community libraries. Each `prompt-templates/*.json`
file carries a `source` block linking back to the original author and post.

### YouMind-OpenLab/awesome-gpt-image-2

- **Repository:** <https://github.com/YouMind-OpenLab/awesome-gpt-image-2>
- **License:** CC BY 4.0 — <https://creativecommons.org/licenses/by/4.0/>
- **Copyright:** © 2026 YouMind OpenLab
- **What we adapted:** A selection of image prompts (featured + a sampled
  slice of the live gallery) re-encoded as JSON with original author
  credit, source URL, and license tag preserved per entry.
- **Changes:** Each entry was lightly normalized — title cleaned, summary
  extracted from the upstream description, category/tag fields inferred
  from the title and prompt body. The prompt body itself is unchanged.
  See `scripts/import-prompt-templates.mjs` for the full pipeline.

### YouMind-OpenLab/awesome-seedance-2-prompts

- **Repository:** <https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts>
- **License:** CC BY 4.0 — <https://creativecommons.org/licenses/by/4.0/>
- **Copyright:** © 2025 YouMind OpenLab
- **What we adapted:** A selection of Seedance 2.0 video prompts (featured
  + a sampled slice of the live gallery) under the same JSON encoding as
  above. Preview thumbnails reference YouMind's Cloudflare Stream / CMS
  hosting; downloadable .mp4 links are kept where the upstream README
  exposes them. The user's browser fetches these on demand only.
- **Changes:** Same normalization as the image library above.

---

## Other upstream resources

Open Design also benefits from a number of openly licensed components
not in this repo's source tree (Anthropic Claude, OpenAI, ByteDance
Seedance, etc.). Those are credited in their respective skill / design
system DESIGN.md or SKILL.md files.

---

## How to add a credit

Whenever you ship a feature that ports content from an external openly
licensed source:

1. Add a section here documenting the upstream URL, license, and what
   you adapted.
2. Embed the source block inside the data file itself (we use a `source`
   key on every prompt template — same pattern works for any new asset).
3. Surface the attribution in the UI when the asset is shown to the
   user. CC BY 4.0 explicitly requires "appropriate credit" be visible
   wherever the user encounters the work.

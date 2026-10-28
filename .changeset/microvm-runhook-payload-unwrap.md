---
'@inkeep/open-knowledge': patch
---

Fix MicroVM run hook ignoring per-space config: a VM now clones the requested repo, branch, and external URL instead of silently falling back to defaults.

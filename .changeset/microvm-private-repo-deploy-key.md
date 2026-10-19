---
'@inkeep/open-knowledge': patch
---

The AWS MicroVM run-hook can now clone a private content repository: supply a read-only SSH deploy key and known-hosts in the `/run` payload. The key is written to the VM only and never logged.

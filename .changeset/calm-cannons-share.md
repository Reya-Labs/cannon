---
'@usecannon/artifact-codec': major
'@usecannon/builder': major
---

Extract Cannon's Kubo-compatible artifact encoding into a browser-safe package and make the builder consume that package without changing persisted CIDs. This is a Cannon v3 breaking release because the fixed public package group, including the CLI and Hardhat plugin entrypoints, now requires Node.js 20.

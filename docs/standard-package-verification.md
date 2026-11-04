# Standard package validation

Validated on **4 November 2026**, independently of the original development deployment. Runtime source files in the release match the tested candidate; the final export adds the completed documentation and integrity manifest.

## Results

| Check | Result |
| --- | --- |
| Clean installation from exported source, empty PostgreSQL volume, and no runtime files | Passed: generated credentials, imported the three CSVs, created Metabase content, and started all three healthy services |
| Database initialization and analytical SQL assertions | Passed: 184 riders, 23 teams, 21 stages, 3,602 results, 24 exits, and 160 full-race finishers |
| Python regression suite in the Linux ARM64 application container | **49 passed** |
| Frontend regression suite | **9 test files passed** |
| Official-image platform manifests | PostgreSQL, Metabase, and Python pins include Linux ARM64 and AMD64 variants |
| Linux AMD64 application image under emulation | Built successfully; **49 Python tests passed** |
| Metabase provisioning and query verification | **31 questions** successfully executed; **5 tabs** and signed embedding configured |
| Shared analytic endpoints | All **8 functions** returned expected results |
| Filter and detail checks | Stage 5 selection returned 179 results; UAE team roster returned 8 riders; France union-member detail returned 51; rider-stage drill stayed scoped to its rider |
| Browser checks | Embedded Metabase charts rendered; Team → 8 Riders → 21 Stage Results drill completed |
| Port changes | Portal/Metabase moved from 18000/13000 to 18001/13001; signed embeds, native links, and custom drill destinations used the new addresses |
| Repeat initialization and stop/start | Original data, object mappings, and all generated secret hashes remained unchanged; endpoint/embedding checks passed afterward |
| Benchmark reproduction | All **3 query pairs** passed exact-result equivalence and completed **7 measured alternating repetitions** each |
| Independent review | Linux UID persistence and credential-maintenance documentation corrected; no remaining important findings in the recheck |
| Exported documentation | Local Markdown links resolve within the selected source files |

Default endpoint row counts: rider standings 160; team standings 23; rider-stage results 3,602; stage summaries 21; country participation 29; terrain specialization 715; team depth 23; GC evolution 105.

## Test boundaries

- Full-stack startup and persistence were tested on **macOS with Docker Desktop, running native Linux ARM64 containers**.
- The **AMD64 application image** was built and tested under emulation. A complete AMD64 PostgreSQL/Metabase stack was not separately exercised.
- `start.ps1` is supplied, but no native Windows/PowerShell execution was available. A native Linux host was not available; the non-default UID/GID behavior is covered by a launcher regression test and persisted Compose configuration.
- Tests use the supplied course dataset; no claim is made about arbitrary replacement datasets, public internet hosting, or production load.

## Release integrity and privacy

The exporter selects only source, data, SQL, tests, documentation, and required assets. It excludes `.runtime/`, `.env`, `.git/`, virtual environments, working logs, database dumps, and private coordination files. Selected files are checked for generated credential values and machine-specific absolute paths. `MANIFEST.sha256` records every exported file except itself; the companion `.zip.sha256` verifies the complete ZIP.

See the [README](../README.md#verification-and-development) for repeatable verification commands and [third-party notices](../THIRD_PARTY_NOTICES.md) for asset provenance.

## Public repository preparation

The public copy adds an MIT license for original code/documentation and replaces the restricted race image with Hugo LUC's CC BY-SA 4.0 photograph. The existing Team Depth screenshot contains no race photograph and remains unchanged. Analytical functions, deployment behavior, and API contracts are unchanged. The source manifest is regenerated for this public copy.

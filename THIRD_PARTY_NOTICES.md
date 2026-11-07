# Third-party notices

The [MIT License](LICENSE) applies to original project code and documentation. Third-party material listed below retains its own rights and license.

## Tour de France photograph

- File: `web/static/assets/tour-de-france-peloton-2024.jpg`.
- Title: **Peloton during Simacourbe climb of Tour de France 2024 stage 13**.
- Photographer: **Hugo LUC**.
- Date: **12 July 2024**.
- [Source and author attribution on Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Peloton_during_Simacourbe_climb_of_Tour_de_France_2024_stage_13.jpg).
- License: [Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/) ([legal code](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en)).
- [Downloaded 1280-pixel rendition](https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ac/Peloton_during_Simacourbe_climb_of_Tour_de_France_2024_stage_13.jpg/1280px-Peloton_during_Simacourbe_climb_of_Tour_de_France_2024_stage_13.jpg).
- Changes: the Wikimedia rendition is stored unchanged. The website displays it with responsive CSS cropping and a dark overlay. Any adaptation of the photograph remains available under CC BY-SA 4.0; the MIT software license does not replace this photo license.

The photograph is illustrative and depicts the 2024 race; the dashboard analyzes the supplied 2025 dataset. No endorsement by the photographer, riders, teams, or race organizer is implied. The previous A.S.O. photograph is not included in this public repository.

## Barlow Condensed fonts

- Files: `web/static/assets/fonts/BarlowCondensed-ExtraBoldItalic.ttf` and `BarlowCondensed-Medium.ttf`.
- Copyright 2017 The Barlow Project Authors.
- Source: [Google Fonts Barlow Condensed directory](https://github.com/google/fonts/tree/main/ofl/barlowcondensed). The font files are bundled unchanged and served locally.
- License: SIL Open Font License 1.1; the full license is included at [`web/static/assets/fonts/OFL.txt`](web/static/assets/fonts/OFL.txt). The MIT code license does not replace the font license.

## Course dataset

`data/riders.csv`, `data/individual_results.csv`, and `data/exits.csv` are the supplied course inputs. No additional rights or official completeness claims are asserted. Outputs follow these files and the documented proxy definitions. The MIT software license does not relicense third-party data.

## Software

The package downloads PostgreSQL, Metabase OSS, and Python from their official image repositories and Python packages from PyPI. Their original licenses apply. Container layers and installed third-party packages are not included in this source repository. Exact pins appear in `compose.yaml`, `Dockerfile`, and `requirements.lock.txt`.

/* ============================================================================
   Tour de France 2025 · P1 Local Analytics Portal Frontend Controller
   - Queries shared PostgreSQL `dw` functions via FastAPI endpoints.
   - Never duplicates ranking or scoring algorithms in JavaScript.
   - Preserves null gaps/rates, ties, exited team members, and #78 ('UNK').
   - Supports validated URL deep links, multi-select pills, pagination,
     Explore Stage & Country drills, and automatic target scroll/focus.
   ============================================================================ */

(function () {
  "use strict";

  const EMBED_REFRESH_LEAD_SECONDS = 60; // Refresh ~9 minutes (540s) into 10-minute (600s) token
  const EMBED_RETRY_DELAY_MS = 60 * 1000;

  const ALLOWED_VIEWS = ["overview", "explore", "methods", "drilldown"];
  let drilldownWorkspace = null;
  const insightPreferences = {};
  const pageTrail = [];
  let drillEntry = null;
  const researchModules = ["rider_specialisation", "gc_evolution", "time_rules"];
  const INSIGHT_MODULES = ["rider_specialisation", "gc_evolution", "team_depth"];
  const ALLOWED_MODULES = [
    "rider_standings",
    "team_standings",
    "stage_summary",
    "country_participation",
    "rider_specialisation",
    "gc_evolution",
    "team_depth",
    "time_rules",
  ];
  const ALLOWED_DRILLS = ["stage", "country", "team", "rider"];
  const ALLOWED_STAGE_SCOPES = ["final", "as_of", "selection"];
  const ALLOWED_STAGE_TYPES = ["flat", "hilly", "mountain", "individual time-trial"];
  const ALLOWED_TIME_BASES = ["adjusted", "finish"];
  const ALLOWED_RANK_SCOPES = ["overall", "filtered"];
  const ALLOWED_TEAM_AGGREGATIONS = ["stage_top3", "cumulative_top3"];
  const ALLOWED_CLASSIFICATIONS = ["gc", "young", "points_proxy", "kom_proxy", "mountain_time"];

  const ALLOWED_URL_PARAM_KEYS = new Set([
    "view",
    "module",
    "tab",
    "classification",
    "drill",
    "stage_id",
    "country_code",
    "team_key",
    "rider_key",
    "stage_scope",
    "as_of_stage",
    "stage_ids",
    "stage_types",
    "time_basis",
    "rank_scope",
    "team_aggregation",
    "team_keys",
    "rider_keys",
    "young_only",
  ]);

  const state = {
    activeView: "overview",
    activeExploreModule: "rider_standings",
    activeEmbedTabIndex: 1,
    activeEmbedTabKey: "tab_1_overview",
    embedRefreshTimerId: null,
    metadata: {
      teams: [],
      riders: [],
      stages: [],
      countries: [],
    },
    embedInfo: null,
    selectedStageIds: [],
    selectedTeamKeys: [],
    selectedRiderKeys: [],
    multiTeamLock: false,
    multiRiderLock: false,
    explicitEmptyArrays: {
      stage_ids: false,
      stage_types: false,
      team_keys: false,
      rider_keys: false,
    },
    drillTeamKey: null,
    drillRiderKey: null,
    drillRosterRows: [],
    latestTeamStandings: [],
    latestStageSummaryRows: [],
    latestCountryParticipationRows: [],
    activeStageDrillId: null,
    activeCountryDrillCode: null,
    specialisationRows: [],
    specialisationPage: 1,
    specialisationPageSize: 100,
    inspectorReturnContext: null,
    requestSeq: {
      embed: 0,
      overview: 0,
      explore: 0,
      roster: 0,
      riderStages: 0,
    },
  };

  // Implementation reference (moved out of visible module descriptions):
  // Standings, stage summaries, country membership and all three extended analyses
  // are served by their existing dw.* functions via the shared /api/analytics interfaces.
  // Stage distance is counted once per stage; country roles use participation grain.
  // Country member detail is a distinct union of nationality and team registration.
  const MODULE_DESCRIPTIONS = {
    rider_standings: {title: "Classifications", desc: ""},
    team_standings: {title: "Riders & Teams", desc: ""},
    stage_summary: {title: "Stages & Routes", desc: ""},
    country_participation: {title: "Country Participation", desc: "Whole-race participation · unknown nationality excluded."},
    rider_specialisation: {title: "Stage Type Fit", desc: ""},
    gc_evolution: {title: "Decisive Stages", desc: ""},
    time_rules: {title: "Time Rules", desc: ""},
    team_depth: {title: "Build a Balanced Squad", desc: ""}
  };

  /* --------------------------------------------------------------------------
     Formatting & Focus Helpers (Display Only — Zero Ranking/Scoring Logic)
     -------------------------------------------------------------------------- */

  function escapeHtml(val) {
    if (val === null || val === undefined) return "";
    return String(val)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) {
      return "—";
    }
    const total = Math.round(Number(seconds));
    const sign = total < 0 ? "-" : "";
    const abs = Math.abs(total);
    const hrs = Math.floor(abs / 3600);
    const mins = Math.floor((abs % 3600) / 60);
    const secs = abs % 60;
    const mm = String(mins).padStart(2, "0");
    const ss = String(secs).padStart(2, "0");
    if (hrs > 0) {
      return `${sign}${hrs}:${mm}:${ss}`;
    }
    return `${sign}${mins}:${ss}`;
  }

  function formatGap(seconds) {
    if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) {
      return "—";
    }
    const val = Math.round(Number(seconds));
    if (val === 0) {
      return "0:00 (Leader)";
    }
    const prefix = val > 0 ? "+" : "-";
    const abs = Math.abs(val);
    const hrs = Math.floor(abs / 3600);
    const mins = Math.floor((abs % 3600) / 60);
    const secs = abs % 60;
    if (hrs > 0) {
      return `${prefix}${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    if (mins > 0) {
      return `${prefix}${mins}:${String(secs).padStart(2, "0")}`;
    }
    return `${prefix}${secs}s`;
  }

  function formatSignedSeconds(seconds) {
    if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) {
      return "—";
    }
    const val = Math.round(Number(seconds));
    if (val === 0) return "0s";
    return val > 0 ? `+${val}s` : `${val}s`;
  }

  function formatPercent(val) {
    if (val === null || val === undefined || Number.isNaN(Number(val))) {
      return "—";
    }
    return `${Number(val).toFixed(2)}%`;
  }

  function formatRatioAsPercent(ratio) {
    if (ratio === null || ratio === undefined || Number.isNaN(Number(ratio))) {
      return "—";
    }
    return `${(Number(ratio) * 100).toFixed(1)}%`;
  }

  function formatKm(km) {
    if (km === null || km === undefined || Number.isNaN(Number(km))) {
      return "—";
    }
    return `${Number(km).toFixed(1)} km`;
  }

  function terrainChip(stageType) {
    const t = String(stageType || "");
    if (t === "mountain") return `<span class="chip chip-crimson">mountain</span>`;
    if (t === "hilly") return `<span class="chip chip-yellow">hilly</span>`;
    if (t === "individual time-trial") return `<span class="chip chip-navy">time-trial</span>`;
    return `<span class="chip chip-green">${escapeHtml(t || "flat")}</span>`;
  }

  function scrollAndFocusElement(el) {
    if (!el) return;
    const disclosure = el.closest("details");
    if (disclosure) disclosure.open = true;
    if (!el.hasAttribute("tabindex")) {
      el.setAttribute("tabindex", "-1");
    }
    try {
      el.scrollIntoView({ block: "start" });
    } catch (_err) {
      el.scrollIntoView();
    }
    try {
      el.focus({ preventScroll: true });
    } catch (_err) {
      el.focus();
    }
  }

  function bindAccessibleRowAction(tr, callback) {
    if (!tr || typeof callback !== "function") return;
    if (!tr.hasAttribute("tabindex")) {
      tr.setAttribute("tabindex", "0");
    }
    if (!tr.hasAttribute("role")) {
      tr.setAttribute("role", "button");
    }
    tr.addEventListener("click", (ev) => {
      callback(ev);
    });
    tr.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        callback(ev);
      }
    });
  }

  function showDeepLinkBanner(title, message) {
    const banner = document.getElementById("deeplink-feedback-banner");
    const titleEl = document.getElementById("deeplink-banner-title");
    const msgEl = document.getElementById("deeplink-banner-message");
    if (!banner) return;
    if (titleEl) titleEl.textContent = title || "Navigation Notice:";
    if (msgEl) msgEl.textContent = message || "";
    banner.classList.remove("hidden");
  }

  function hideDeepLinkBanner() {
    const banner = document.getElementById("deeplink-feedback-banner");
    if (banner) banner.classList.add("hidden");
  }

  /* --------------------------------------------------------------------------
     Filter Payload Builder (Includes Only Present Keys; Preserves Multi-Select)
     -------------------------------------------------------------------------- */

  function getActiveTeamKeys() {
    if (state.explicitEmptyArrays.team_keys) {
      return [];
    }
    if (state.selectedTeamKeys.length > 0) {
      return state.selectedTeamKeys.slice();
    }
    const teamSelectEl = document.getElementById("filter-team-select");
    if (teamSelectEl && teamSelectEl.value) {
      const tKey = parseInt(teamSelectEl.value, 10);
      if (!Number.isNaN(tKey) && tKey >= 1) {
        return [tKey];
      }
    }
    return null;
  }

  function getActiveRiderKeys() {
    if (state.explicitEmptyArrays.rider_keys) {
      return [];
    }
    if (state.selectedRiderKeys.length > 0) {
      return state.selectedRiderKeys.slice();
    }
    const riderSelectEl = document.getElementById("filter-rider-select");
    if (riderSelectEl && riderSelectEl.value) {
      const rKey = parseInt(riderSelectEl.value, 10);
      if (!Number.isNaN(rKey) && rKey >= 1) {
        return [rKey];
      }
    }
    return null;
  }

  function buildFilterPayload(overrides) {
    const scopeEl = document.getElementById("filter-stage-scope");
    const asOfEl = document.getElementById("filter-as-of-stage");
    const basisEl = document.getElementById("filter-time-basis");
    const rankScopeEl = document.getElementById("filter-rank-scope");
    const teamAggEl = document.getElementById("filter-team-aggregation");
    const youngOnlyEl = document.getElementById("filter-young-only");

    const payload = {};
    const stageScope = scopeEl ? scopeEl.value : "final";
    if (stageScope) {
      payload.stage_scope = stageScope;
    }

    if (stageScope === "as_of" && asOfEl && asOfEl.value) {
      const parsedAsOf = parseInt(asOfEl.value, 10);
      if (!Number.isNaN(parsedAsOf)) {
        payload.as_of_stage = parsedAsOf;
      }
    }

    if (stageScope === "selection") {
      const checkedTypes = Array.from(
        document.querySelectorAll('input[name="stage_types"]:checked')
      ).map((cb) => cb.value);
      if (state.explicitEmptyArrays.stage_types && checkedTypes.length === 0) {
        payload.stage_types = [];
      } else if (checkedTypes.length > 0) {
        payload.stage_types = checkedTypes;
      }

      if (state.explicitEmptyArrays.stage_ids && state.selectedStageIds.length === 0) {
        payload.stage_ids = [];
      } else if (state.selectedStageIds.length > 0) {
        payload.stage_ids = state.selectedStageIds.slice();
      }
    }

    if (basisEl && basisEl.value) {
      payload.time_basis = basisEl.value;
    }
    if (rankScopeEl && rankScopeEl.value) {
      payload.rank_scope = rankScopeEl.value;
    }
    if (teamAggEl && teamAggEl.value) {
      payload.team_aggregation = teamAggEl.value;
    }

    const activeTeams = getActiveTeamKeys();
    if (activeTeams !== null) {
      payload.team_keys = activeTeams;
    }

    const activeRiders = getActiveRiderKeys();
    if (activeRiders !== null) {
      payload.rider_keys = activeRiders;
    }

    if (youngOnlyEl && youngOnlyEl.checked) {
      payload.young_only = true;
    }

    if (overrides && typeof overrides === "object") {
      Object.keys(overrides).forEach((k) => {
        if (overrides[k] === undefined || overrides[k] === null) {
          delete payload[k];
        } else {
          payload[k] = overrides[k];
        }
      });
    }

    return payload;
  }

  function buildStageScopeOnlyFilters() {
    const full = buildFilterPayload();
    const scoped = {};
    if (full.stage_scope) scoped.stage_scope = full.stage_scope;
    if (full.as_of_stage !== undefined) scoped.as_of_stage = full.as_of_stage;
    if (full.stage_ids !== undefined) scoped.stage_ids = full.stage_ids;
    if (full.stage_types !== undefined) scoped.stage_types = full.stage_types;
    if (full.time_basis) scoped.time_basis = full.time_basis;
    if (full.young_only) scoped.young_only = full.young_only;
    return scoped;
  }

  function buildEmbedQuerySearchParams(filtersOverride) {
    const params = new URLSearchParams();
    if (state.activeEmbedTabKey) {
      params.set("tab", state.activeEmbedTabKey);
    }

    const filters = filtersOverride || buildFilterPayload();
    if (filters.stage_scope) {
      params.set("stage_scope", String(filters.stage_scope));
    }
    if (filters.as_of_stage !== undefined && filters.as_of_stage !== null) {
      params.set("as_of_stage", String(filters.as_of_stage));
    }
    if (filters.time_basis) {
      params.set("time_basis", String(filters.time_basis));
    }
    if (filters.rank_scope) {
      params.set("rank_scope", String(filters.rank_scope));
    }
    if (filters.young_only !== undefined && filters.young_only !== null) {
      params.set("young_only", filters.young_only ? "true" : "false");
    }

    // Forward array filters as repeated URL parameters; preserve explicit empty `[]` as `key=`
    ["stage_ids", "stage_types", "team_keys", "rider_keys"].forEach((arrKey) => {
      if (Array.isArray(filters[arrKey])) {
        if (filters[arrKey].length === 0) {
          params.set(arrKey, "");
        } else {
          filters[arrKey].forEach((item) => {
            if (item !== null && item !== undefined) {
              params.append(arrKey, String(item));
            }
          });
        }
      }
    });

    // Note: `team_aggregation` is intentionally omitted because P0 side-by-side cards use fixed methods.
    return params;
  }

  /* --------------------------------------------------------------------------
     Scope Banner & Honest Metric Descriptions (Never Claim Full GC on Selection)
     -------------------------------------------------------------------------- */

  function getScopeDescriptor(filtersOverride) {
    const filters = filtersOverride || buildFilterPayload();
    if (filters.stage_scope === "as_of") {
      const s = filters.as_of_stage || 21;
      return {
        mode: "as_of",
        shortLabel: `Cumulative As-Of Stage ${s} (Stages 1..${s})`,
        standingsTitle: `As-Of Stage ${s} Standings (Stages 1–${s})`,
        teamTitle: `As-Of Stage ${s} Team Standings`,
        gcOptionLabel: `Cumulative Time Standings (Stages 1–${s})`,
      };
    }
    if (filters.stage_scope === "selection") {
      const idsDesc =
        filters.stage_ids && filters.stage_ids.length
          ? `Stages [${filters.stage_ids.join(", ")}]`
          : filters.stage_types && filters.stage_types.length
          ? `Stage Types [${filters.stage_types.join(", ")}]`
          : "Selected Subset";
      return {
        mode: "selection",
        shortLabel: `Selected-Stage Performance (${idsDesc} · Non-Full GC)`,
        standingsTitle: `Selected-Stage Performance (${idsDesc} · Non-Full GC)`,
        teamTitle: `Selected-Stage Team Performance (${idsDesc})`,
        gcOptionLabel: "Selected-Stage Cumulative Time (Non-Full GC)",
      };
    }
    return {
      mode: "final",
      shortLabel: "Final Full-Race Scope (Stages 1–21)",
      standingsTitle: "Classification Leaders (Full 21-Stage Race)",
      teamTitle: "Team Standings (Full 21-Stage Race)",
      gcOptionLabel: "General Classification (GC)",
    };
  }

  function syncClassificationDropdownLabels(desc) {
    ["overview-classification-select", "explore-classification-select"].forEach((id) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const gcOpt = sel.querySelector('option[value="gc"]');
      if (gcOpt) {
        gcOpt.textContent = desc.gcOptionLabel;
      }
    });
  }

  function updateScopeBanner() {
    const filters = buildFilterPayload();
    const desc = getScopeDescriptor(filters);
    const scopePill = document.getElementById("active-scope-pill");
    const basisPill = document.getElementById("active-basis-pill");
    const drillBadge = document.getElementById("drill-scope-badge");
    const overviewGcTitle = document.getElementById("overview-gc-card-title");
    const overviewTeamTitle = document.getElementById("overview-team-card-title");

    const cohort = document.getElementById("active-cohort-label");
    if (cohort) cohort.textContent = [filters.team_keys ? `${filters.team_keys.length} team(s)` : "All teams", filters.rider_keys ? `${filters.rider_keys.length} rider(s)` : "All riders", filters.young_only ? "Young only" : null, filters.stage_types?.length ? filters.stage_types.join(" / ") : null, filters.team_aggregation === "cumulative_top3" ? "Cumulative top-3" : null, filters.rank_scope === "filtered" ? "Subgroup rank" : null].filter(Boolean).join(" · ");
    if (scopePill) scopePill.title = desc.shortLabel;
    if (cohort) cohort.title = cohort.textContent;
    syncClassificationDropdownLabels(desc);
    if (overviewGcTitle) overviewGcTitle.textContent = desc.mode === "final" ? "Classification leaders" : desc.mode === "as_of" ? `Leaders through Stage ${filters.as_of_stage || 21}` : "Selected-stage leaders";
    if (overviewTeamTitle) overviewTeamTitle.textContent = desc.mode === "final" ? "Team standings" : "Team standings · active scope";

    const basisLabel =
      filters.time_basis === "finish"
        ? "Finish time"
        : "Adjusted time";
    if (basisPill) basisPill.textContent = basisLabel;

    if (filters.stage_scope === "as_of") {
      const s = filters.as_of_stage || 21;
      if (scopePill) scopePill.textContent = `Through Stage ${s} · stages 1–${s}`;
      if (drillBadge) drillBadge.textContent = `Stages 1..${s}`;
    } else if (filters.stage_scope === "selection") {
      const idsDesc =
        filters.stage_ids && filters.stage_ids.length
          ? `Stages [${filters.stage_ids.join(", ")}]`
          : "all matching stages";
      if (scopePill) scopePill.textContent = `Selected-Stage Performance (${idsDesc})`;
      if (drillBadge) drillBadge.textContent = `Custom Selection`;
    } else {
      if (scopePill) scopePill.textContent = "Final race · stages 1–21";
      if (drillBadge) drillBadge.textContent = "All 21 Stages";
    }
  }

  /* --------------------------------------------------------------------------
     HTTP Fetch Helpers
     -------------------------------------------------------------------------- */

  async function apiGet(path) {
    const resp = await fetch(path, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    let data = null;
    try {
      data = await resp.json();
    } catch (_err) {
      data = null;
    }
    if (!resp.ok) {
      const err = new Error(
        (data && data.detail && (data.detail.message || data.detail)) ||
          `HTTP ${resp.status}`
      );
      err.status = resp.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  async function apiPost(path, bodyObj) {
    const resp = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(bodyObj || {}),
    });
    let data = null;
    try {
      data = await resp.json();
    } catch (_err) {
      data = null;
    }
    if (!resp.ok) {
      const err = new Error(
        (data && data.detail && (data.detail.message || data.detail)) ||
          `HTTP ${resp.status}`
      );
      err.status = resp.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  /* --------------------------------------------------------------------------
     Health, Metadata & Dropdown Initialization
     -------------------------------------------------------------------------- */

  function updateP0Links(url) {
    if (!url) return;
    ["p0-native-link", "topbar-p0-link", "embed-fallback-p0-link"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.setAttribute("href", url);
    });
  }

  async function loadHealth() {
    const dot = document.getElementById("health-status-dot");
    try {
      const health = await apiGet("/api/health");
      if (health.p0_dashboard_url) {
        updateP0Links(health.p0_dashboard_url);
      }
      if (dot) {
        dot.textContent = health.embed_configured
          ? "Ready"
          : health.database_configured
          ? "Data Ready"
          : "Offline";
      }
      if (Array.isArray(health.tabs) && health.tabs.length > 0) {
        renderEmbedTabButtons(health.tabs);
      }
    } catch (_err) {
      if (dot) dot.textContent = "Offline";
    }
  }

  async function loadMetadata() {
    try {
      const meta = await apiGet("/api/metadata");
      state.metadata.teams = meta.teams || [];
      state.metadata.riders = meta.riders || [];
      state.metadata.stages = meta.stages || [];
      state.metadata.countries = meta.countries || [];
      renderRaceContext(meta);
      populateFilterDropdowns();
    } catch (_err) {
      renderRaceContext(null);
      populateFallbackStageOptions();
    }
  }

  function populateFallbackStageOptions() {
    const asOfSelect = document.getElementById("filter-as-of-stage");
    const stageDropdown = document.getElementById("filter-stage-dropdown");
    if (asOfSelect && asOfSelect.options.length <= 1) {
      asOfSelect.innerHTML = "";
      for (let i = 1; i <= 21; i += 1) {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = `Stage ${i}`;
        if (i === 21) opt.selected = true;
        asOfSelect.appendChild(opt);
      }
    }
    if (stageDropdown && stageDropdown.options.length <= 1) {
      stageDropdown.innerHTML = `<option value="">Choose Stage (1..21)…</option>`;
      for (let i = 1; i <= 21; i += 1) {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = `Stage ${i}`;
        stageDropdown.appendChild(opt);
      }
    }
  }

  function populateFilterDropdowns() {
    const teamSelect = document.getElementById("filter-team-select");
    const drillTeamSelect = document.getElementById("drill-team-select");
    const riderSelect = document.getElementById("filter-rider-select");
    const asOfSelect = document.getElementById("filter-as-of-stage");
    const stageDropdown = document.getElementById("filter-stage-dropdown");

    if (teamSelect) {
      const currentVal = teamSelect.value;
      teamSelect.innerHTML = `<option value="">All 23 Participating Teams</option>`;
      state.metadata.teams.forEach((t) => {
        const opt = document.createElement("option");
        opt.value = String(t.team_key);
        const countrySuffix = t.team_country_code ? ` (${t.team_country_code})` : "";
        opt.textContent = `${t.team_name}${countrySuffix}`;
        teamSelect.appendChild(opt);
      });
      if (currentVal) teamSelect.value = currentVal;
    }

    if (drillTeamSelect) {
      const currentDrill = drillTeamSelect.value;
      drillTeamSelect.innerHTML = `<option value="">Choose a team…</option>`;
      state.metadata.teams.forEach((t) => {
        const opt = document.createElement("option");
        opt.value = String(t.team_key);
        const finisherPart =
          t.finisher_count !== undefined && t.participant_count !== undefined
            ? ` · ${t.finisher_count}/${t.participant_count} finished`
            : "";
        opt.textContent = `${t.team_name}${finisherPart}`;
        drillTeamSelect.appendChild(opt);
      });
      if (currentDrill) {
        drillTeamSelect.value = currentDrill;
      } else if (state.metadata.teams.length > 0 && !state.drillTeamKey) {
        state.drillTeamKey = state.metadata.teams[0].team_key;
        drillTeamSelect.value = String(state.drillTeamKey);
      }
    }

    if (riderSelect) {
      const currentRider = riderSelect.value;
      riderSelect.innerHTML = `<option value="">All Participating Riders (184)</option>`;
      state.metadata.riders.forEach((r) => {
        const opt = document.createElement("option");
        opt.value = String(r.rider_key);
        const statusTag = r.finished_race_flag === 1 ? "" : " [Exited]";
        const countryTag = r.rider_country_code || "UNK";
        opt.textContent = `#${r.bib_number} ${r.rider_name} (${countryTag} · ${r.team_name})${statusTag}`;
        riderSelect.appendChild(opt);
      });
      if (currentRider) riderSelect.value = currentRider;
    }

    if (state.metadata.stages.length > 0) {
      if (asOfSelect) {
        const currentAsOf = asOfSelect.value || "21";
        asOfSelect.innerHTML = "";
        state.metadata.stages.forEach((s) => {
          const opt = document.createElement("option");
          opt.value = String(s.stage_id);
          opt.textContent = `Stage ${s.stage_id} · ${s.stage_date} · ${s.stage_type} (${s.start_location_name} -> ${s.finish_location_name})`;
          asOfSelect.appendChild(opt);
        });
        asOfSelect.value = currentAsOf;
      }

      if (stageDropdown) {
        stageDropdown.innerHTML = `<option value="">Select stage (Stage · Date · Type)…</option>`;
        state.metadata.stages.forEach((s) => {
          const opt = document.createElement("option");
          opt.value = String(s.stage_id);
          opt.textContent =
            s.dropdown_label ||
            `Stage ${s.stage_id} · ${s.stage_date} · ${s.stage_type} · ${s.distance_km} km`;
          stageDropdown.appendChild(opt);
        });
      }
    } else {
      populateFallbackStageOptions();
    }

    renderSelectedTeamPills();
    renderSelectedRiderPills();
  }

  /* --------------------------------------------------------------------------
     Signed Metabase Embed Loader & Single Cancellable Pre-Expiry Timer
     -------------------------------------------------------------------------- */

  function clearEmbedRefreshTimer() {
    if (state.embedRefreshTimerId !== null) {
      clearTimeout(state.embedRefreshTimerId);
      state.embedRefreshTimerId = null;
    }
  }

  function scheduleEmbedRefresh(delayMs) {
    clearEmbedRefreshTimer();
    const safeDelay = Math.max(15000, Number(delayMs) || 9 * 60 * 1000);
    state.embedRefreshTimerId = setTimeout(() => {
      state.embedRefreshTimerId = null;
      loadSignedEmbed();
    }, safeDelay);
  }

  function renderEmbedTabButtons(tabs) {
    const container = document.getElementById("embed-tabs-buttons");
    const modeNote = document.getElementById("embed-tabs-mode-note");
    if (!container || !Array.isArray(tabs) || tabs.length === 0) return;

    const hasMappedIds = tabs.some((t) => t.tab_id !== null && t.tab_id !== undefined);
    if (modeNote) {
      modeNote.textContent = hasMappedIds
        ? "Explore five analytical views"
        : "Explore five analytical views (switch tabs inside the embedded dashboard)";
    }

    container.innerHTML = "";
    tabs.forEach((tab) => {
      const btn = document.createElement("button");
      btn.type = "button";
      const canonicalKey = tab.key || `tab_${tab.index}`;
      btn.className =
        "embed-tab-btn" + (canonicalKey === state.activeEmbedTabKey ? " active" : "");
      btn.setAttribute("data-tab-index", String(tab.index));
      btn.setAttribute("data-tab-key", canonicalKey);
      btn.textContent = tab.short_label || tab.label;
      btn.title = tab.description || tab.label;
      btn.addEventListener("click", () => {
        state.activeEmbedTabIndex = tab.index;
        // Always send canonical tab key (`tab_2_classifications`) so the server resolves once
        state.activeEmbedTabKey = canonicalKey;
        Array.from(container.querySelectorAll(".embed-tab-btn")).forEach((b) =>
          b.classList.remove("active")
        );
        btn.classList.add("active");
        if (tab.tab_id !== null && tab.tab_id !== undefined) {
          loadSignedEmbed();
        }
      });
      container.appendChild(btn);
    });
  }

  async function loadSignedEmbed() {
    const panel=document.getElementById("bi-disclosure");
    if (state.activeView !== "overview" || (panel && !panel.open)) return;

    clearEmbedRefreshTimer();
    const reqId = ++state.requestSeq.embed;
    const loadingBox = document.getElementById("embed-loading-state");
    const errorBox = document.getElementById("embed-error-state");
    const errorTitle = document.getElementById("embed-error-title");
    const errorMsg = document.getElementById("embed-error-message");
    const iframe = document.getElementById("metabase-iframe");

    if (loadingBox) loadingBox.classList.remove("hidden");
    if (errorBox) errorBox.classList.add("hidden");
    if (iframe) iframe.classList.add("hidden");

    const params = buildEmbedQuerySearchParams();
    const queryStr = params.toString() ? `?${params.toString()}` : "";

    try {
      const embed = await apiGet(`/api/embed${queryStr}`);
      if (reqId !== state.requestSeq.embed) return;
      state.embedInfo = embed;
      if (embed.p0_dashboard_url) {
        updateP0Links(embed.p0_dashboard_url);
      }
      if (Array.isArray(embed.tabs) && embed.tabs.length > 0) {
        renderEmbedTabButtons(embed.tabs);
      }
      if (loadingBox) loadingBox.classList.add("hidden");
      if (iframe && embed.iframe_url) {
        iframe.src = embed.iframe_url;
        iframe.classList.remove("hidden");
      }

      // Schedule single refresh ~9 minutes before the 10-minute token expires
      const expiresInSec = Number(embed.expires_in_seconds) || 600;
      const refreshInMs = Math.max(60, expiresInSec - EMBED_REFRESH_LEAD_SECONDS) * 1000;
      scheduleEmbedRefresh(refreshInMs);
    } catch (err) {
      if (reqId !== state.requestSeq.embed) return;
      if (loadingBox) loadingBox.classList.add("hidden");
      if (errorBox) errorBox.classList.remove("hidden");
      const detailObj = err.payload && err.payload.detail ? err.payload.detail : null;
      if (detailObj && detailObj.p0_dashboard_url) {
        updateP0Links(detailObj.p0_dashboard_url);
      }
      if (detailObj && Array.isArray(detailObj.tabs)) {
        renderEmbedTabButtons(detailObj.tabs);
      }
      if (errorTitle) {
        errorTitle.textContent =
          err.status === 503
            ? "Embedded Race Dashboard Not Yet Configured"
            : "Unable to Load Embedded Race Dashboard";
      }
      if (errorMsg) {
        errorMsg.textContent =
          (detailObj && detailObj.message) ||
          err.message ||
          "Open Metabase or continue with the analysis tables.";
      }
      // Retry gracefully without accumulating timers
      scheduleEmbedRefresh(EMBED_RETRY_DELAY_MS);
    }
  }

  /* --------------------------------------------------------------------------
     Return Context Tracking for Inspector
     -------------------------------------------------------------------------- */

  function captureReturnContext() {
    return {
      view: state.activeView,
      exploreModule: state.activeExploreModule,
      stageDrillId: state.activeStageDrillId,
      countryDrillCode: state.activeCountryDrillCode,
    };
  }

  function updateInspectorReturnButton() {
    const backBtn = document.getElementById("drill-back-btn");
    if (!backBtn) return;
    const ctx = state.inspectorReturnContext;
    if (!ctx) {
      backBtn.classList.add("hidden");
      return;
    }
    let label = "← Back to Exploration";
    if (ctx.view === "explore") {
      if (ctx.stageDrillId) {
        label = `← Back to Stage ${ctx.stageDrillId} Results`;
      } else if (ctx.countryDrillCode) {
        label = `← Back to Country (${ctx.countryDrillCode})`;
      } else {
        const modMeta = MODULE_DESCRIPTIONS[ctx.exploreModule];
        label = modMeta ? `← Back to ${modMeta.title}` : "← Back to Explore";
      }
    } else if (ctx.view === "overview") {
      label = "← Back to Dashboard Overview";
    }
    backBtn.textContent = label;
    backBtn.classList.remove("hidden");
  }

  function returnFromInspector() {
    const ctx = state.inspectorReturnContext;
    if (!ctx) {
      const target =
        state.activeView === "explore"
          ? document.getElementById("explore-module-title")
          : document.getElementById("workspace-heading");
      scrollAndFocusElement(target);
      return;
    }
    if (ctx.view === "explore") {
      if (state.activeView !== "explore") {
        switchWorkspaceView("explore", { skipRefresh: true });
      }
      if (ctx.stageDrillId) {
        const heading = document.getElementById("explore-stage-detail-heading");
        if (heading && state.activeStageDrillId === ctx.stageDrillId) {
          scrollAndFocusElement(heading);
        } else {
          openStageDetailDrill(ctx.stageDrillId, { scroll: true });
        }
        return;
      }
      if (ctx.countryDrillCode) {
        const heading = document.getElementById("explore-country-detail-heading");
        if (heading && state.activeCountryDrillCode === ctx.countryDrillCode) {
          scrollAndFocusElement(heading);
        } else {
          openCountryMemberDrill(ctx.countryDrillCode, { scroll: true });
        }
        return;
      }
      if (ctx.exploreModule && state.activeExploreModule !== ctx.exploreModule) {
        activateExploreModuleTab(ctx.exploreModule);
      }
      scrollAndFocusElement(
        document.getElementById("explore-module-title") ||
          document.getElementById("explore-table-container")
      );
      return;
    }
    if (state.activeView !== ctx.view) {
      switchWorkspaceView(ctx.view);
    }
    scrollAndFocusElement(
      document.getElementById("overview-gc-card-title") ||
        document.getElementById("workspace-heading")
    );
  }

  function clearInspectorDrill() {
    ++state.requestSeq.roster;
    ++state.requestSeq.riderStages;
    state.drillTeamKey = null;
    state.drillRiderKey = null;
    state.drillRosterRows = [];
    const drillSelect = document.getElementById("drill-team-select");
    if (drillSelect) drillSelect.value = "";
    const summaryStrip = document.getElementById("drill-team-summary");
    if (summaryStrip) summaryStrip.classList.add("hidden");

    const rosterContainer = document.getElementById("drill-roster-container");
    const stagesContainer = document.getElementById("drill-stages-container");
    const rosterHeading = document.getElementById("drill-roster-heading");
    const headingEl = document.getElementById("drill-rider-heading");
    const subheadingEl = document.getElementById("drill-rider-subheading");

    if (rosterHeading) {
      rosterHeading.textContent = "Team Roster & Available-Stage Contributions";
    }
    if (headingEl) headingEl.textContent = "Rider Stage-by-Stage Results";
    if (subheadingEl) {
      subheadingEl.textContent =
        "";
    }
    renderStateBox(
      rosterContainer,
      "empty",
      "No Team Selected",
      "Select a team to view its roster."
    );
    renderStateBox(
      stagesContainer,
      "empty",
      "No Rider Selected",
      "Select a rider to view stage results."
    );

    Array.from(document.querySelectorAll("tr.selected-row")).forEach((tr) =>
      tr.classList.remove("selected-row")
    );

    returnFromInspector();
  }

  /* --------------------------------------------------------------------------
     Table Renderers for Shared Warehouse Functions
     -------------------------------------------------------------------------- */

  function renderStateBox(container, type, title, message) {
    if (!container) return;
    container.innerHTML = `
      <div class="state-box state-${escapeHtml(type)}">
        <h4>${escapeHtml(title)}</h4>
        <p>${escapeHtml(message)}</p>
      </div>
    `;
  }

  function renderRiderStandingsTable(container, rows, classification, compact) {
    if (!container) return;
    if (!Array.isArray(rows) || rows.length === 0) {
      renderStateBox(
        container,
        "empty",
        "No Eligible Riders Match Current Scope",
        "No riders completed all required stages under the active filter selection."
      );
      return;
    }

    const scopeDesc = getScopeDescriptor();
    const isPointsMode =
      classification === "points_proxy" || classification === "kom_proxy";
    if (compact) container.classList.toggle("points-preview", isPointsMode);
    const displayRows = compact ? rows.slice(0, 15) : rows;
    const timeColHeader = isPointsMode
      ? "Proxy Points"
      : scopeDesc.mode === "selection"
      ? "Selected-Stage Time (Non-Full GC)"
      : scopeDesc.mode === "as_of"
      ? "As-Of Cumulative Time"
      : "Cumulative Time";

    const scopeBarHtml = !compact
      ? `
        <div class="table-scope-bar">
          <span><strong>Active Scope:</strong> ${escapeHtml(scopeDesc.shortLabel)}</span>
          <span><strong>Eligible Riders Shown:</strong> ${rows.length}</span>
        </div>
      `
      : "";

    const html = `
      ${scopeBarHtml}
      <table class="data-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Bib · Rider</th>
            <th>Team</th>
            <th>Young Rider</th>
            <th class="num-col">Stages</th>
            <th class="num-col">${timeColHeader}</th>
            <th class="num-col">${isPointsMode ? "Time (Ref)" : "Gap to Leader"}</th>
            <th class="num-col">Percentile</th>
          </tr>
        </thead>
        <tbody>
          ${displayRows
            .map((r) => {
              const youngChip = r.is_young_rider
                ? `<span class="chip chip-green">Young Rider</span>`
                : `<span class="chip chip-neutral">—</span>`;
              const primaryMetric = isPointsMode
                ? `<strong>${escapeHtml(r.points)} pts</strong>`
                : `<strong>${formatDuration(r.total_seconds)}</strong>`;
              const secondaryMetric = isPointsMode
                ? formatDuration(r.total_seconds)
                : formatGap(r.gap_seconds);
              const riderLabel = `#${r.bib_number} ${r.rider_name}`;
              return `
                <tr class="clickable-row" data-rider-key="${escapeHtml(r.rider_key)}" data-team-key="${escapeHtml(r.team_key)}" aria-label="Inspect stage trajectory for ${escapeHtml(riderLabel)}" title="Click to inspect team &amp; stage results">
                  <td class="rank-cell">#${escapeHtml(r.rank)}</td>
                  <td>
                    <button type="button" class="table-link-btn" data-rider-key="${escapeHtml(r.rider_key)}" data-team-key="${escapeHtml(r.team_key)}" aria-label="Inspect stage trajectory for ${escapeHtml(riderLabel)}">
                      #${escapeHtml(r.bib_number)} ${escapeHtml(r.rider_name)}
                    </button>
                  </td>
                  <td>${escapeHtml(r.team_name)}</td>
                  <td>${youngChip}</td>
                  <td class="num-col">${escapeHtml(r.stage_count)}</td>
                  <td class="num-col">${primaryMetric}</td>
                  <td class="num-col">${secondaryMetric}</td>
                  <td class="num-col">${formatPercent(r.rank_percentile)}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;
    container.innerHTML = html;

    Array.from(container.querySelectorAll("tr.clickable-row")).forEach((tr) => {
      bindAccessibleRowAction(tr, () => {
        const tKey = parseInt(tr.getAttribute("data-team-key"), 10);
        const rKey = parseInt(tr.getAttribute("data-rider-key"), 10);
        if (!Number.isNaN(tKey)) {
          selectTeamForDrill(tKey, !Number.isNaN(rKey) ? rKey : null, {
            focusTarget: !Number.isNaN(rKey) ? "rider" : "roster",
            returnContext: captureReturnContext(),
          });
        }
      });
    });
  }

  function renderTeamStandingsTable(container, rows) {
    if (!container) return;
    if (!Array.isArray(rows) || rows.length === 0) {
      renderStateBox(
        container,
        "empty",
        "No Eligible Teams Match Current Scope",
        "Teams require at least 3 qualifying riders across the selected stages."
      );
      return;
    }

    const html = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Team</th>
            <th class="num-col">Stages</th>
            <th class="num-col">Contributors</th>
            <th class="num-col">Team Time</th>
            <th class="num-col">Gap to Leader</th>
            <th>Method</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((t) => {
              const isSelected = Number(t.team_key) === Number(state.drillTeamKey);
              return `
                <tr class="clickable-row ${isSelected ? "selected-row" : ""}" data-team-key="${escapeHtml(t.team_key)}" aria-label="Inspect full team roster for ${escapeHtml(t.team_name)}" title="Click to load full team roster in drill panel">
                  <td class="rank-cell">#${escapeHtml(t.rank)}</td>
                  <td>
                    <button type="button" class="table-link-btn" data-team-key="${escapeHtml(t.team_key)}" aria-label="Inspect full team roster for ${escapeHtml(t.team_name)}">
                      ${escapeHtml(t.team_name)}
                    </button>
                  </td>
                  <td class="num-col">${escapeHtml(t.stage_count)}</td>
                  <td class="num-col">${escapeHtml(t.contributor_count)}</td>
                  <td class="num-col"><strong>${formatDuration(t.total_seconds)}</strong></td>
                  <td class="num-col">${formatGap(t.gap_seconds)}</td>
                  <td>${t.team_aggregation === "stage_top3" ? "Per-stage top 3" : "Cumulative top 3"}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;
    container.innerHTML = html;

    Array.from(container.querySelectorAll("tr.clickable-row")).forEach((tr) => {
      bindAccessibleRowAction(tr, () => {
        const tKey = parseInt(tr.getAttribute("data-team-key"), 10);
        if (!Number.isNaN(tKey)) {
          selectTeamForDrill(tKey, null, {
            focusTarget: "roster",
            returnContext: captureReturnContext(),
          });
        }
      });
    });
  }

  /* --------------------------------------------------------------------------
     Deliverable 2: Explore Stage Summary & Stage Result Detail View
     -------------------------------------------------------------------------- */

  function renderStageSummaryTable(container, rows) {
    if (!container) return;
    state.latestStageSummaryRows = Array.isArray(rows) ? rows : [];
    if (!Array.isArray(rows) || rows.length === 0) {
      renderStateBox(
        container,
        "empty",
        "No Stages in Current Selection",
        "Adjust stage filters to view stage summaries."
      );
      return;
    }
    const totalKm = rows.reduce((acc, r) => acc + (Number(r.distance_km) || 0), 0);
    container.innerHTML = `
      <div class="table-scope-bar">
        <span>
          <strong>Stages Shown:</strong> ${rows.length} &nbsp;·&nbsp;
          <strong>Unduplicated Distance Sum:</strong> <code>${formatKm(totalKm)}</code>
        </span>
        <!-- Stage rows open individual results. -->
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Date · Wk</th>
            <th>Stage Type</th>
            <th>Route (Start → Finish)</th>
            <th class="num-col">Distance</th>
            <th class="num-col">Stage Finishers</th>
            <th>Stage Winner</th>
            <th class="num-col">Winning Time (Adj)</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (s) => `
              <tr class="clickable-row" data-stage-id="${escapeHtml(s.stage_id)}" aria-label="Open Stage ${escapeHtml(s.stage_id)} results (${escapeHtml(s.route_description)})" title="Click to inspect all ${escapeHtml(s.finisher_count)} results for Stage ${escapeHtml(s.stage_id)}">
                <td class="rank-cell">
                  <button type="button" class="table-link-btn" data-stage-id="${escapeHtml(s.stage_id)}" aria-label="View Stage ${escapeHtml(s.stage_id)} results">
                    Stage ${escapeHtml(s.stage_id)} →
                  </button>
                </td>
                <td>${escapeHtml(s.stage_date)} <small>(W${escapeHtml(s.race_week)})</small></td>
                <td>${terrainChip(s.stage_type)}</td>
                <td>${escapeHtml(s.route_description)}</td>
                <td class="num-col">${formatKm(s.distance_km)}</td>
                <td class="num-col">${escapeHtml(s.finisher_count)}</td>
                <td><strong>#${escapeHtml(s.winner_bib_number)} ${escapeHtml(s.winner_rider_name)}</strong> <small>(${escapeHtml(s.winner_team_name)})</small></td>
                <td class="num-col">${formatDuration(s.winning_adjusted_time_seconds)}</td>
              </tr>
            `
            )
            .join("")}
        </tbody>
      </table>
    `;

    Array.from(container.querySelectorAll("tr.clickable-row")).forEach((tr) => {
      bindAccessibleRowAction(tr, () => {
        const sId = parseInt(tr.getAttribute("data-stage-id"), 10);
        if (!Number.isNaN(sId)) {
          openStageDetailDrill(sId, { scroll: true });
        }
      });
    });
  }

  function buildStageDetailFilterPayload(stageId) {
    // Use existing shared rider_stage_results with selected stage and current relevant
    // rider/team/young/time filters. Never silently lose clicked stage due to final/as_of
    // or conflicting terrain selection in the global scope controls.
    const current = buildFilterPayload();
    const payload = {
      stage_scope: "selection",
      stage_ids: [Number(stageId)],
    };
    if (current.time_basis) payload.time_basis = current.time_basis;
    if (Array.isArray(current.team_keys)) payload.team_keys = current.team_keys.slice();
    if (Array.isArray(current.rider_keys)) payload.rider_keys = current.rider_keys.slice();
    if (current.young_only) payload.young_only = true;
    return payload;
  }

  async function openStageDetailDrill(stageId, options) {
    const opts = options || {};
    const parsedStageId = parseInt(stageId, 10);
    if (globalThis.RacePages?.stage_summary && parsedStageId >= 1 && parsedStageId <= 21) {
      return goToAnalysis("stage_summary", {stageId:parsedStageId}, state.activeView !== "explore" || state.activeExploreModule !== "stage_summary");
    }
    const container = document.getElementById("explore-table-container");
    const titleEl = document.getElementById("explore-module-title");
    const descEl = document.getElementById("explore-module-desc");
    const clsWrap = document.getElementById("explore-classification-wrap");

    if (state.activeView !== "explore") {
      switchWorkspaceView("explore", { skipRefresh: true });
    }
    activateExploreModuleTab("stage_summary", { skipRefresh: true });
    if (clsWrap) clsWrap.classList.add("hidden");

    if (Number.isNaN(parsedStageId) || parsedStageId < 1 || parsedStageId > 21) {
      state.activeStageDrillId = null;
      if (titleEl) titleEl.textContent = "Invalid Stage Selection";
      if (descEl) descEl.textContent = "Stage number must be between 1 and 21.";
      if (container) {
        container.innerHTML = `
          <div class="drill-detail-bar">
            <div class="drill-detail-top">
              <h4 class="drill-detail-title" id="explore-stage-detail-heading" tabindex="-1">
                Invalid Stage Number (${escapeHtml(stageId)})
              </h4>
              <button type="button" id="back-to-stage-summary-btn" class="btn-secondary btn-compact">
                ← Back to Stage Summary
              </button>
            </div>
          </div>
          <div class="state-box state-warning">
            <h4>Stage Not Found</h4>
            <p>Tour de France 2025 includes Stages 1 through 21. Choose a valid stage to inspect results.</p>
          </div>
        `;
        const backBtn = document.getElementById("back-to-stage-summary-btn");
        if (backBtn) {
          backBtn.addEventListener("click", () => {
            state.activeStageDrillId = null;
            refreshExplorerModule({ scroll: true });
          });
        }
        if (opts.scroll !== false) {
          scrollAndFocusElement(document.getElementById("explore-stage-detail-heading"));
        }
      }
      return;
    }

    state.activeStageDrillId = parsedStageId;
    state.activeCountryDrillCode = null;
    const reqId = ++state.requestSeq.explore;

    const stageMeta =
      state.metadata.stages.find((s) => Number(s.stage_id) === parsedStageId) ||
      state.latestStageSummaryRows.find((s) => Number(s.stage_id) === parsedStageId) ||
      null;

    const routeLabel = stageMeta
      ? stageMeta.route_description ||
        `${stageMeta.start_location_name} -> ${stageMeta.finish_location_name}`
      : `Stage ${parsedStageId}`;

    if (titleEl) {
      titleEl.textContent = `Stage ${parsedStageId} Results — ${routeLabel}`;
    }
    if (descEl) {
      descEl.textContent =
        "";
    }

    renderStateBox(
      container,
      "loading",
      `Loading Stage ${parsedStageId} Results…`,
      `Fetching stage finishers for Stage ${parsedStageId} (${routeLabel})…`
    );

    const queryPayload = buildStageDetailFilterPayload(parsedStageId);
    try {
      const resp = await apiPost("/api/analytics/rider_stage_results", queryPayload);
      if (reqId !== state.requestSeq.explore) return;
      const rows = resp.rows || [];
      renderStageDetailView(container, parsedStageId, stageMeta, rows, queryPayload);
      if (opts.scroll !== false) {
        scrollAndFocusElement(
          document.getElementById("explore-stage-detail-heading") || container
        );
      }
    } catch (err) {
      if (reqId !== state.requestSeq.explore) return;
      renderStateBox(
        container,
        "warning",
        `Unable to Load Stage ${parsedStageId} Results`,
        err.message || "Verify PostgreSQL connection and filter selection."
      );
    }
  }

  function renderStageDetailView(container, stageId, stageMeta, rows, appliedFilters) {
    if (!container) return;
    const sampleRow = rows[0] || {};
    const routeText =
      (stageMeta &&
        (stageMeta.route_description ||
          `${stageMeta.start_location_name} (${stageMeta.start_country_code}) -> ${stageMeta.finish_location_name} (${stageMeta.finish_country_code})`)) ||
      sampleRow.stage_name ||
      `Stage ${stageId}`;
    const stageDate = (stageMeta && stageMeta.stage_date) || sampleRow.stage_date || "—";
    const raceWeek = (stageMeta && stageMeta.race_week) || sampleRow.race_week || "—";
    const stageType = (stageMeta && stageMeta.stage_type) || sampleRow.stage_type || "flat";
    const distanceKm =
      stageMeta && stageMeta.distance_km !== undefined
        ? stageMeta.distance_km
        : sampleRow.distance_km;
    const globalFinisherCount =
      (stageMeta && stageMeta.finisher_count) ||
      sampleRow.stage_finisher_count ||
      rows.length;
    const basisLabel =
      appliedFilters.time_basis === "finish" ? "Raw Finish Time" : "Adjusted Time";

    const titleEl = document.getElementById("explore-module-title");
    if (titleEl) {
      titleEl.textContent = `Stage ${stageId} results`;
    }

    const headerBarHtml = `
      <div class="drill-detail-bar" id="explore-stage-detail-bar">
        <div class="drill-detail-top">
          <h4 class="drill-detail-title" id="explore-stage-detail-heading" tabindex="-1">
            ${escapeHtml(routeText)}
          </h4>
          <button type="button" id="back-to-stage-summary-btn" class="btn-secondary btn-compact">
            ← Back to Stage Summary
          </button>
        </div>
        <div class="drill-detail-metrics">
          <span><strong>Stage:</strong> Stage ${escapeHtml(stageId)} (${escapeHtml(stageDate)} · Week ${escapeHtml(raceWeek)})</span>
          <span><strong>Stage Type:</strong> ${terrainChip(stageType)}</span>
          <span><strong>Distance:</strong> <code>${formatKm(distanceKm)}</code></span>
          <span><strong>Displayed / Stage Finishers:</strong> <strong>${rows.length}</strong> / ${escapeHtml(globalFinisherCount)} rows</span>
          <span><strong>Time Basis:</strong> ${escapeHtml(basisLabel)}</span>
        </div>
      </div>
    `;

    if (rows.length === 0) {
      container.innerHTML = `
        ${headerBarHtml}
        <div class="state-box state-empty">
          <h4>No Stage ${escapeHtml(stageId)} Results Match Active Filters</h4>
          <p>No riders on Stage ${escapeHtml(stageId)} matched the active Team, Rider, or Young Rider filter.</p>
        </div>
      `;
    } else {
      container.innerHTML = `
        ${headerBarHtml}
        <table class="data-table">
          <thead>
            <tr>
              <th>Stage Rank</th>
              <th>Bib · Rider</th>
              <th>Nat.</th>
              <th>Team</th>
              <th class="num-col">Raw Time</th>
              <th class="num-col">Bonus / Pen</th>
              <th class="num-col">Adjusted Time</th>
              <th class="num-col">Gap (Raw / Adj)</th>
              <th class="num-col">Pts / KOM Proxy</th>
              <th class="num-col">Percentile</th>
              <th>Race Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((r) => {
                const youngBadge = r.is_young_rider
                  ? ` <span class="chip chip-green">Young Rider</span>`
                  : "";
                const statusBadge =
                  Number(r.finished_race_flag) === 1
                    ? `<span class="chip chip-green">Finished (21/21)</span>`
                    : `<span class="chip chip-crimson">Exited Race</span>`;
                const riderLabel = `#${r.bib_number} ${r.rider_name}`;
                return `
                  <tr class="clickable-row" data-rider-key="${escapeHtml(r.rider_key)}" data-team-key="${escapeHtml(r.team_key)}" aria-label="Inspect stage trajectory for ${escapeHtml(riderLabel)}" title="Click to open ${escapeHtml(riderLabel)} stage trajectory in Inspector">
                    <td class="rank-cell">#${escapeHtml(r.finish_rank)} <small>/ ${escapeHtml(r.stage_finisher_count)}</small></td>
                    <td>
                      <button type="button" class="table-link-btn" data-rider-key="${escapeHtml(r.rider_key)}" data-team-key="${escapeHtml(r.team_key)}" aria-label="Inspect stage trajectory for ${escapeHtml(riderLabel)}">
                        #${escapeHtml(r.bib_number)} ${escapeHtml(r.rider_name)}
                      </button>${youngBadge}
                    </td>
                    <td title="${escapeHtml(r.rider_country_name || "Unknown / Unspecified")}"><code>${escapeHtml(r.rider_country_code || "UNK")}</code></td>
                    <td>${escapeHtml(r.team_name)}</td>
                    <td class="num-col">${formatDuration(r.finish_time_seconds)}</td>
                    <td class="num-col">−${escapeHtml(r.time_bonus_seconds)}s / +${escapeHtml(r.time_penalty_seconds)}s</td>
                    <td class="num-col"><strong>${formatDuration(r.adjusted_time_seconds)}</strong></td>
                    <td class="num-col">${formatGap(r.gap_seconds)} / <strong>${formatGap(r.adjusted_gap_seconds)}</strong></td>
                    <td class="num-col">${escapeHtml(r.stage_points_proxy)} / ${escapeHtml(r.kom_points_proxy)}</td>
                    <td class="num-col">${formatPercent(r.rank_percentile)}</td>
                    <td>${statusBadge}</td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      `;
    }

    const backBtn = document.getElementById("back-to-stage-summary-btn");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        state.activeStageDrillId = null;
        refreshExplorerModule({ scroll: true });
      });
    }

    Array.from(container.querySelectorAll("tr.clickable-row")).forEach((tr) => {
      bindAccessibleRowAction(tr, () => {
        const tKey = parseInt(tr.getAttribute("data-team-key"), 10);
        const rKey = parseInt(tr.getAttribute("data-rider-key"), 10);
        if (!Number.isNaN(tKey)) {
          selectTeamForDrill(tKey, !Number.isNaN(rKey) ? rKey : null, {
            focusTarget: "rider",
            returnContext: captureReturnContext(),
          });
        }
      });
    });
  }

  /* --------------------------------------------------------------------------
     Deliverable 3: Explore Countries & Country Union-Member Detail View
     -------------------------------------------------------------------------- */

  function renderCountryParticipationTable(container, rows) {
    if (!container) return;
    state.latestCountryParticipationRows = Array.isArray(rows) ? rows : [];
    if (!Array.isArray(rows) || rows.length === 0) {
      renderStateBox(
        container,
        "empty",
        "No Country Rows Returned",
        "No countries matched the current filter."
      );
      return;
    }
    container.innerHTML = `
      <div class="table-scope-bar">
        <span>
          <strong>Known Countries Shown:</strong> ${rows.length} (excludes <code>UNK</code> from nationality summary)
        </span>
        <!-- Country rows open members by nationality and team registration. -->
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Country</th>
            <th class="num-col">Registered Teams</th>
            <th class="num-col">Participating Riders</th>
            <th class="num-col">Race Finishers</th>
            <th class="num-col">Finisher Rate</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((c) => {
              const rateDisplay =
                c.finisher_rate === null ||
                c.finisher_rate === undefined ||
                Number(c.rider_count) === 0
                  ? "— (0 riders)"
                  : formatRatioAsPercent(c.finisher_rate);
              return `
                <tr class="clickable-row" data-country-code="${escapeHtml(c.country_code)}" aria-label="Inspect ${escapeHtml(c.country_name)} (${escapeHtml(c.country_code)}) member details" title="Click to inspect ${escapeHtml(c.country_name)} (${escapeHtml(c.country_code)}) riders and registered teams">
                  <td><code>${escapeHtml(c.country_code)}</code></td>
                  <td>
                    <button type="button" class="table-link-btn" data-country-code="${escapeHtml(c.country_code)}" aria-label="View ${escapeHtml(c.country_name)} (${escapeHtml(c.country_code)}) member details">
                      ${escapeHtml(c.country_name)} →
                    </button>
                  </td>
                  <td class="num-col">${escapeHtml(c.team_count)}</td>
                  <td class="num-col">${escapeHtml(c.rider_count)}</td>
                  <td class="num-col">${escapeHtml(c.finisher_count)}</td>
                  <td class="num-col">${rateDisplay}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;

    Array.from(container.querySelectorAll("tr.clickable-row")).forEach((tr) => {
      bindAccessibleRowAction(tr, () => {
        const code = tr.getAttribute("data-country-code");
        if (code) {
          openCountryMemberDrill(code, { scroll: true });
        }
      });
    });
  }

  function buildCountryDetailFilterPayload() {
    const current = buildFilterPayload();
    const payload = {};
    if (Array.isArray(current.team_keys)) payload.team_keys = current.team_keys.slice();
    if (Array.isArray(current.rider_keys)) payload.rider_keys = current.rider_keys.slice();
    if (current.young_only) payload.young_only = true;
    return payload;
  }

  async function openCountryMemberDrill(rawCountryCode, options) {
    const opts = options || {};
    const normalizedCode = String(rawCountryCode || "").trim().toUpperCase();
    if (globalThis.RacePages?.country_participation && state.metadata.countries.some(c=>c.country_code===normalizedCode)) {
      return goToAnalysis("country_participation", {countryCode:normalizedCode}, state.activeView !== "explore" || state.activeExploreModule !== "country_participation");
    }
    const container = document.getElementById("explore-table-container");
    const titleEl = document.getElementById("explore-module-title");
    const descEl = document.getElementById("explore-module-desc");
    const clsWrap = document.getElementById("explore-classification-wrap");

    if (state.activeView !== "explore") {
      switchWorkspaceView("explore", { skipRefresh: true });
    }
    activateExploreModuleTab("country_participation", { skipRefresh: true });
    if (clsWrap) clsWrap.classList.add("hidden");

    const isFormatValid =
      /^[A-Z]{3}$/.test(normalizedCode) &&
      normalizedCode !== "UNK" &&
      normalizedCode !== "NULL";
    const knownMeta =
      state.metadata.countries.find((c) => c.country_code === normalizedCode) ||
      state.latestCountryParticipationRows.find((c) => c.country_code === normalizedCode) ||
      null;
    const isKnownWhenMetadataLoaded =
      state.metadata.countries.length === 0 || Boolean(knownMeta);

    if (!isFormatValid || !isKnownWhenMetadataLoaded) {
      state.activeCountryDrillCode = null;
      state.activeStageDrillId = null;
      if (titleEl) {
        titleEl.textContent = `Unknown or Invalid Country Code (${normalizedCode || "empty"})`;
      }
      if (descEl) {
        descEl.textContent =
          "Country Participation excludes 'UNK' and requires a valid 3-letter known country code.";
      }
      if (container) {
        container.innerHTML = `
          <div class="drill-detail-bar" id="explore-country-detail-bar">
            <div class="drill-detail-top">
              <h4 class="drill-detail-title" id="explore-country-detail-heading" tabindex="-1">
                Unknown or Invalid Country (${escapeHtml(normalizedCode || "empty")})
              </h4>
              <button type="button" id="back-to-countries-btn" class="btn-secondary btn-compact">
                ← Back to Country Participation
              </button>
            </div>
          </div>
          <div class="state-box state-warning">
            <h4>Country Not Found in Known Country Universe</h4>
            <p>
              The code <code>${escapeHtml(normalizedCode || "empty")}</code> is not a valid known country in this dataset.
              Note that unspecified rider nationality (<code>UNK</code>, bib #78) is excluded from nationality distribution tables but preserved in team rosters and stage results.
            </p>
          </div>
        `;
        const backBtn = document.getElementById("back-to-countries-btn");
        if (backBtn) {
          backBtn.addEventListener("click", () => {
            state.activeCountryDrillCode = null;
            refreshExplorerModule({ scroll: true });
          });
        }
        if (opts.scroll !== false) {
          scrollAndFocusElement(document.getElementById("explore-country-detail-heading"));
        }
      }
      return;
    }

    state.activeCountryDrillCode = normalizedCode;
    state.activeStageDrillId = null;
    const reqId = ++state.requestSeq.explore;

    const countryName = (knownMeta && knownMeta.country_name) || normalizedCode;
    if (titleEl) {
      titleEl.textContent = `Country Member Detail: ${countryName} (${normalizedCode})`;
    }
    if (descEl) {
      descEl.textContent =
        "Members match rider nationality, team registration, or both. Each rider appears once.";
    }

    renderStateBox(
      container,
      "loading",
      `Loading ${countryName} (${normalizedCode}) Members…`,
      "Loading country members…"
    );

    const countryFilters = buildCountryDetailFilterPayload();
    try {
      const resp = await apiPost(
        `/api/country/${encodeURIComponent(normalizedCode)}/members`,
        countryFilters
      );
      if (reqId !== state.requestSeq.explore) return;
      renderCountryMemberDetailView(container, normalizedCode, knownMeta, resp);
      if (opts.scroll !== false) {
        scrollAndFocusElement(
          document.getElementById("explore-country-detail-heading") || container
        );
      }
    } catch (err) {
      if (reqId !== state.requestSeq.explore) return;
      renderStateBox(
        container,
        "warning",
        `Unable to Load Country Members for ${normalizedCode}`,
        err.message || "Verify PostgreSQL connection and country code."
      );
    }
  }

  function renderCountryMemberDetailView(container, countryCode, countryMeta, resp) {
    if (!container) return;
    const rows = (resp && resp.rows) || [];
    const countryName =
      (resp && resp.country_name) ||
      (countryMeta && countryMeta.country_name) ||
      countryCode;
    const summary = (resp && resp.summary) || {
      union_member_count: rows.length,
      rider_national_count: rows.filter(
        (r) =>
          r.is_rider_national === true ||
          r.role_code === "rider_nationality" ||
          r.role_code === "both"
      ).length,
      registered_team_member_count: rows.filter(
        (r) =>
          r.is_team_registered === true ||
          r.role_code === "team_registration" ||
          r.role_code === "both"
      ).length,
      registered_team_count: new Set(
        rows
          .filter(
            (r) =>
              r.is_team_registered === true ||
              r.role_code === "team_registration" ||
              r.role_code === "both"
          )
          .map((r) => r.team_key)
      ).size,
      both_roles_count: rows.filter((r) => r.role_code === "both").length,
      rider_nationality_only_count: rows.filter((r) => r.role_code === "rider_nationality")
        .length,
      team_registration_only_count: rows.filter((r) => r.role_code === "team_registration")
        .length,
    };

    const titleEl = document.getElementById("explore-module-title");
    if (titleEl) {
      titleEl.textContent = `Country members · ${countryName}`;
    }

    const headerBarHtml = `
      <div class="drill-detail-bar" id="explore-country-detail-bar">
        <div class="drill-detail-top">
          <h4 class="drill-detail-title" id="explore-country-detail-heading" tabindex="-1">
            Country Member Detail: ${escapeHtml(countryName)} (${escapeHtml(countryCode)}) · ${rows.length} Union Members
          </h4>
          <button type="button" id="back-to-countries-btn" class="btn-secondary btn-compact">
            ← Back to Country Participation
          </button>
        </div>
        <div class="drill-detail-metrics">
          <span><strong>Union Members (No Duplicates):</strong> <strong>${summary.union_member_count}</strong></span>
          <span><strong>Rider Nationality (${escapeHtml(countryCode)}):</strong> <strong>${summary.rider_national_count}</strong> nationals (${summary.rider_nationality_only_count} nationality only · ${summary.both_roles_count} both)</span>
          <span><strong>Team Registration (${escapeHtml(countryCode)}):</strong> <strong>${summary.registered_team_member_count}</strong> team riders across <strong>${summary.registered_team_count}</strong> registered teams (${summary.team_registration_only_count} team registration only · ${summary.both_roles_count} both)</span>
        </div>
      </div>
    `;

    if (rows.length === 0) {
      container.innerHTML = `
        ${headerBarHtml}
        <div class="state-box state-empty">
          <h4>Zero Participating Members for ${escapeHtml(countryName)} (${escapeHtml(countryCode)})</h4>
          <p>
            ${escapeHtml(countryName)} (${escapeHtml(countryCode)}) has 0 participating riders of this nationality and 0 registered-team roster members under the active filter scope.
          </p>
        </div>
      `;
    } else {
      container.innerHTML = `
        ${headerBarHtml}
        <table class="data-table">
          <thead>
            <tr>
              <th>Bib · Rider (Inspect Trajectory)</th>
              <th>Country Membership Role</th>
              <th>Rider Nationality</th>
              <th>Team &amp; Registration (Inspect Roster)</th>
              <th>Young Rider</th>
              <th>Race Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((r) => {
                let roleChip = `<span class="chip chip-navy">Team Registration</span>`;
                if (r.role_code === "both") {
                  roleChip = `<span class="chip chip-yellow">Rider Nationality &amp; Team Registration</span>`;
                } else if (r.role_code === "rider_nationality") {
                  roleChip = `<span class="chip chip-green">Rider Nationality</span>`;
                }
                const youngChip = r.is_young_rider
                  ? `<span class="chip chip-green">Young Rider</span>`
                  : `<span class="chip chip-neutral">—</span>`;
                const statusBadge =
                  Number(r.finished_race_flag) === 1
                    ? `<span class="chip chip-green">Finished (21/21)</span>`
                    : `<span class="chip chip-crimson">Exited Race</span>`;
                const riderLabel = `#${r.bib_number} ${r.rider_name}`;
                return `
                  <tr class="clickable-row" data-rider-key="${escapeHtml(r.rider_key)}" data-team-key="${escapeHtml(r.team_key)}" aria-label="Inspect stage trajectory for ${escapeHtml(riderLabel)} or team roster for ${escapeHtml(r.team_name)}">
                    <td>
                      <button type="button" class="table-link-btn country-member-rider-btn" data-rider-key="${escapeHtml(r.rider_key)}" data-team-key="${escapeHtml(r.team_key)}" aria-label="Inspect stage trajectory for ${escapeHtml(riderLabel)}">
                        #${escapeHtml(r.bib_number)} ${escapeHtml(r.rider_name)} →
                      </button>
                    </td>
                    <td>${roleChip}</td>
                    <td title="${escapeHtml(r.rider_country_name || "Unknown / Unspecified")}">
                      <code>${escapeHtml(r.rider_country_code || "UNK")}</code>
                      <small>${escapeHtml(r.rider_country_name || "Unknown / Unspecified")}</small>
                    </td>
                    <td>
                      <button type="button" class="table-link-btn country-member-team-btn" data-team-key="${escapeHtml(r.team_key)}" aria-label="Inspect full team roster for ${escapeHtml(r.team_name)}">
                        ${escapeHtml(r.team_name)} (${escapeHtml(r.team_country_code)}) →
                      </button>
                    </td>
                    <td>${youngChip}</td>
                    <td>${statusBadge}</td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      `;
    }

    const backBtn = document.getElementById("back-to-countries-btn");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        state.activeCountryDrillCode = null;
        refreshExplorerModule({ scroll: true });
      });
    }

    Array.from(container.querySelectorAll(".country-member-team-btn")).forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const tKey = parseInt(btn.getAttribute("data-team-key"), 10);
        if (!Number.isNaN(tKey)) {
          selectTeamForDrill(tKey, null, {
            focusTarget: "roster",
            returnContext: captureReturnContext(),
          });
        }
      });
    });

    Array.from(container.querySelectorAll(".country-member-rider-btn")).forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const tKey = parseInt(btn.getAttribute("data-team-key"), 10);
        const rKey = parseInt(btn.getAttribute("data-rider-key"), 10);
        if (!Number.isNaN(tKey)) {
          selectTeamForDrill(tKey, !Number.isNaN(rKey) ? rKey : null, {
            focusTarget: "rider",
            returnContext: captureReturnContext(),
          });
        }
      });
    });

    Array.from(container.querySelectorAll("tr.clickable-row")).forEach((tr) => {
      bindAccessibleRowAction(tr, (ev) => {
        if (ev && ev.target && ev.target.closest(".country-member-team-btn")) {
          return;
        }
        const tKey = parseInt(tr.getAttribute("data-team-key"), 10);
        const rKey = parseInt(tr.getAttribute("data-rider-key"), 10);
        if (!Number.isNaN(tKey)) {
          selectTeamForDrill(tKey, !Number.isNaN(rKey) ? rKey : null, {
            focusTarget: "rider",
            returnContext: captureReturnContext(),
          });
        }
      });
    });
  }

  /* --------------------------------------------------------------------------
     Deliverable 1 (A1): Terrain Specialisation Pagination (All 715 Rows)
     -------------------------------------------------------------------------- */

  function renderRiderSpecialisationTable(container, rows, options = {}) {
    state.specialisationRows = Array.isArray(rows) ? rows : [];
    if (!options.preservePage) state.specialisationPage = 1;
    renderRiderSpecialisationPage(container);
  }

  function renderRiderSpecialisationPage(container) {
    if (!container) return;
    const rows = state.specialisationRows || [];
    if (rows.length === 0) {
      renderStateBox(
        container,
        "empty",
        "No Stage Type Specialisation Rows",
        "Adjust rider, team, or stage type filters."
      );
      return;
    }

    const totalRows = rows.length;
    const effectivePageSize =
      state.specialisationPageSize > 0 ? state.specialisationPageSize : totalRows;
    const totalPages = Math.max(1, Math.ceil(totalRows / effectivePageSize));
    state.specialisationPage = Math.min(Math.max(1, state.specialisationPage), totalPages);

    const startIdx = (state.specialisationPage - 1) * effectivePageSize;
    const endIdx = Math.min(startIdx + effectivePageSize, totalRows);
    const displayRows = rows.slice(startIdx, endIdx);

    function buildPaginationBarHtml(positionSuffix) {
      return `
        <div class="pagination-bar ${positionSuffix === "bottom" ? "pagination-bar-bottom" : ""}" data-pagination-bar="${escapeHtml(positionSuffix)}">
          <div class="pagination-info">
            Showing <strong>${startIdx + 1}–${endIdx}</strong> of <strong>${totalRows}</strong> rows
            <span class="label-hint">(Page ${state.specialisationPage} of ${totalPages})</span>
          </div>
          <div class="pagination-controls">
            <label for="spec-page-size-${escapeHtml(positionSuffix)}" class="control-label-inline">Rows/page:</label>
            <select id="spec-page-size-${escapeHtml(positionSuffix)}" class="pagination-select" data-spec-page-size aria-label="Stage type specialisation rows per page">
              <option value="50" ${state.specialisationPageSize === 50 ? "selected" : ""}>50</option>
              <option value="100" ${state.specialisationPageSize === 100 ? "selected" : ""}>100</option>
              <option value="250" ${state.specialisationPageSize === 250 ? "selected" : ""}>250</option>
              <option value="0" ${state.specialisationPageSize === 0 ? "selected" : ""}>All (${totalRows})</option>
            </select>
            <button type="button" class="btn-secondary btn-compact" data-spec-page-action="first" ${state.specialisationPage <= 1 ? "disabled" : ""} aria-label="First page">
              « First
            </button>
            <button type="button" class="btn-secondary btn-compact" data-spec-page-action="prev" ${state.specialisationPage <= 1 ? "disabled" : ""} aria-label="Previous page">
              ‹ Prev
            </button>
            <button type="button" class="btn-secondary btn-compact" data-spec-page-action="next" ${state.specialisationPage >= totalPages ? "disabled" : ""} aria-label="Next page">
              Next ›
            </button>
            <button type="button" class="btn-secondary btn-compact" data-spec-page-action="last" ${state.specialisationPage >= totalPages ? "disabled" : ""} aria-label="Last page">
              Last »
            </button>
            ${
              endIdx < totalRows
                ? `<button type="button" class="btn-secondary btn-compact" data-spec-page-action="all" aria-label="Show all ${totalRows} rows">Show All (${totalRows})</button>`
                : ""
            }
          </div>
        </div>
      `;
    }

    container.innerHTML = `
      ${buildPaginationBarHtml("top")}
      <table class="data-table">
        <thead>
          <tr>
            <th>Bib · Rider</th>
            <th>Team</th>
            <th>Stage Type</th>
            <th class="num-col">Stages (Sample)</th>
            <th class="num-col">Avg Rank Percentile</th>
            <th class="num-col">Top-10 Finishes</th>
            <th class="num-col">Top-10 Ratio</th>
            <th class="num-col">Stage Wins</th>
            <th class="num-col">Mean Gap to Winner</th>
          </tr>
        </thead>
        <tbody>
          ${displayRows
            .map((r) => {
              const riderLabel = `#${r.bib_number} ${r.rider_name}`;
              return `
                <tr class="clickable-row" data-team-key="${escapeHtml(r.team_key)}" data-rider-key="${escapeHtml(r.rider_key)}" aria-label="Inspect stage trajectory for ${escapeHtml(riderLabel)} (${escapeHtml(r.stage_type)})" title="Click to inspect ${escapeHtml(riderLabel)} stage trajectory">
                  <td>
                    <button type="button" class="table-link-btn" data-team-key="${escapeHtml(r.team_key)}" data-rider-key="${escapeHtml(r.rider_key)}" aria-label="Inspect stage trajectory for ${escapeHtml(riderLabel)}">
                      #${escapeHtml(r.bib_number)} ${escapeHtml(r.rider_name)}
                    </button>
                  </td>
                  <td>${escapeHtml(r.team_name)}</td>
                  <td>${terrainChip(r.stage_type)}</td>
                  <td class="num-col">${escapeHtml(r.sample_count)}</td>
                  <td class="num-col"><strong>${formatPercent(r.avg_rank_percentile)}</strong></td>
                  <td class="num-col">${escapeHtml(r.top10_count)}</td>
                  <td class="num-col">${formatRatioAsPercent(r.top10_ratio)}</td>
                  <td class="num-col">${escapeHtml(r.win_count)}</td>
                  <td class="num-col">${formatGap(r.mean_gap_seconds)}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
      ${buildPaginationBarHtml("bottom")}
    `;

    Array.from(container.querySelectorAll("[data-spec-page-size]")).forEach((sel) => {
      sel.addEventListener("change", () => {
        const parsed = parseInt(sel.value, 10);
        state.specialisationPageSize = Number.isNaN(parsed) ? 100 : parsed;
        state.specialisationPage = 1;
        renderRiderSpecialisationPage(container);
      });
    });

    Array.from(container.querySelectorAll("[data-spec-page-action]")).forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-spec-page-action");
        if (action === "first") {
          state.specialisationPage = 1;
        } else if (action === "prev") {
          state.specialisationPage = Math.max(1, state.specialisationPage - 1);
        } else if (action === "next") {
          state.specialisationPage = Math.min(totalPages, state.specialisationPage + 1);
        } else if (action === "last") {
          state.specialisationPage = totalPages;
        } else if (action === "all") {
          state.specialisationPageSize = 0;
          state.specialisationPage = 1;
        }
        renderRiderSpecialisationPage(container);
      });
    });

    Array.from(container.querySelectorAll("tr.clickable-row")).forEach((tr) => {
      bindAccessibleRowAction(tr, () => {
        const tKey = parseInt(tr.getAttribute("data-team-key"), 10);
        const rKey = parseInt(tr.getAttribute("data-rider-key"), 10);
        if (!Number.isNaN(tKey)) {
          selectTeamForDrill(tKey, !Number.isNaN(rKey) ? rKey : null, {
            focusTarget: !Number.isNaN(rKey) ? "rider" : "roster",
            returnContext: captureReturnContext(),
          });
        }
      });
    });
  }

  function renderGcEvolutionTable(container, rows) {
    if (!container) return;
    if (!Array.isArray(rows) || rows.length === 0) {
      renderStateBox(
        container,
        "empty",
        "No GC Evolution Rows",
        "Adjust stage cutoff or rider/team selection."
      );
      return;
    }
    container.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Stage Type</th>
            <th>Bib · Rider</th>
            <th>Team</th>
            <th class="num-col">GC Rank (At S)</th>
            <th class="num-col">Cumulative Time</th>
            <th class="num-col">Cumulative Gap</th>
            <th class="num-col">Stage Net Δ</th>
            <th class="num-col">Cumul. Bonus / Pen</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((r) => {
              const riderLabel = `#${r.bib_number} ${r.rider_name}`;
              return `
                <tr class="clickable-row" data-team-key="${escapeHtml(r.team_key)}" data-rider-key="${escapeHtml(r.rider_key)}" aria-label="Inspect stage trajectory for ${escapeHtml(riderLabel)}" title="Click to inspect ${escapeHtml(riderLabel)} stage trajectory">
                  <td class="rank-cell">Stage ${escapeHtml(r.stage_id)}</td>
                  <td>${terrainChip(r.stage_type)}</td>
                  <td>
                    <button type="button" class="table-link-btn" data-team-key="${escapeHtml(r.team_key)}" data-rider-key="${escapeHtml(r.rider_key)}" aria-label="Inspect stage trajectory for ${escapeHtml(riderLabel)}">
                      #${escapeHtml(r.bib_number)} ${escapeHtml(r.rider_name)}
                    </button>
                  </td>
                  <td>${escapeHtml(r.team_name)}</td>
                  <td class="rank-cell num-col">#${escapeHtml(r.cumulative_rank)}</td>
                  <td class="num-col">${formatDuration(r.cumulative_seconds)}</td>
                  <td class="num-col"><strong>${formatGap(r.cumulative_gap_seconds)}</strong></td>
                  <td class="num-col">${formatSignedSeconds(r.stage_net_change_seconds)}</td>
                  <td class="num-col">−${escapeHtml(r.cumulative_bonus_seconds)}s / +${escapeHtml(r.cumulative_penalty_seconds)}s</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;

    Array.from(container.querySelectorAll("tr.clickable-row")).forEach((tr) => {
      bindAccessibleRowAction(tr, () => {
        const tKey = parseInt(tr.getAttribute("data-team-key"), 10);
        const rKey = parseInt(tr.getAttribute("data-rider-key"), 10);
        if (!Number.isNaN(tKey)) {
          selectTeamForDrill(tKey, !Number.isNaN(rKey) ? rKey : null, {
            focusTarget: !Number.isNaN(rKey) ? "rider" : "roster",
            returnContext: captureReturnContext(),
          });
        }
      });
    });
  }

  function renderTeamDepthTable(container, rows) {
    if (!container) return;
    if (!Array.isArray(rows) || rows.length === 0) {
      renderStateBox(
        container,
        "empty",
        "No Team Depth Rows",
        "No teams matched the active filter selection."
      );
      return;
    }
    container.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Team</th>
            <th class="num-col">Stage Wins</th>
            <th class="num-col">Podiums</th>
            <th class="num-col">Top-10 Finishes</th>
            <th class="num-col">Top-10 Stage Coverage</th>
            <th class="num-col">Distinct Top-10 Riders</th>
            <th class="num-col">Race Finishers / Starters</th>
            <th class="num-col">Finisher Rate</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (t) => `
              <tr class="clickable-row" data-team-key="${escapeHtml(t.team_key)}" aria-label="Inspect full team roster for ${escapeHtml(t.team_name)}" title="Click to inspect team roster in expandable drill panel">
                <td>
                  <button type="button" class="table-link-btn" data-team-key="${escapeHtml(t.team_key)}" aria-label="Inspect full team roster for ${escapeHtml(t.team_name)}">
                    ${escapeHtml(t.team_name)}
                  </button>
                </td>
                <td class="num-col"><strong>${escapeHtml(t.wins)}</strong></td>
                <td class="num-col">${escapeHtml(t.podiums)}</td>
                <td class="num-col">${escapeHtml(t.top10_finishes)}</td>
                <td class="num-col">${escapeHtml(t.top10_stages)}/${escapeHtml(t.selected_stage_count)} (${formatRatioAsPercent(t.top10_stage_coverage)})</td>
                <td class="num-col">${escapeHtml(t.top10_distinct_riders)}</td>
                <td class="num-col">${escapeHtml(t.finishers)} / ${escapeHtml(t.participants)}</td>
                <td class="num-col">${formatRatioAsPercent(t.finisher_rate)}</td>
              </tr>
            `
            )
            .join("")}
        </tbody>
      </table>
    `;
    Array.from(container.querySelectorAll("tr.clickable-row")).forEach((tr) => {
      bindAccessibleRowAction(tr, () => {
        const tKey = parseInt(tr.getAttribute("data-team-key"), 10);
        if (!Number.isNaN(tKey)) {
          selectTeamForDrill(tKey, null, {
            focusTarget: "roster",
            returnContext: captureReturnContext(),
          });
        }
      });
    });
  }

  /* --------------------------------------------------------------------------
     Overview & Explorer Data Loaders
     -------------------------------------------------------------------------- */

  let finalGCLeaders, finalTeamLeaders;
  function renderOverviewAward(container, rows, kind) {
    if (!container) return;
    if (!rows.length) return renderStateBox(container, "warning", "Standings unavailable", "");
    const entityKey = kind === "team" ? "team_key" : "rider_key";
    const entityName = kind === "team" ? "team_name" : "rider_name";
    const podium = rows.slice(0,3);
    const displayRows = podium.length === 3 ? [podium[1],podium[0],podium[2]] : podium;
    container.innerHTML = '<div class="finish-pair">' + displayRows.map(row =>
      '<button class="finish-rider' + (Number(row.rank) === 1 ? ' podium-winner' : '') + '" type="button" data-award-kind="' + kind + '" data-award-key="' + Number(row[entityKey]) + '"><small><span class="award-medal" aria-hidden="true">🏅</span>' + (kind === "team" ? "Team " : "GC ") + Number(row.rank) +
      '</small><strong>' + escapeHtml(row[entityName]) + '</strong><span>' + (kind === "team" ? Number(row.contributor_count) + ' contributors' : escapeHtml(row.team_name)) +
      '</span></button>'
    ).join("") + '</div>';
    container.querySelectorAll("[data-award-key]").forEach(button => button.onclick = () =>
      goToAnalysis(kind === "team" ? "team_standings" : "rider_standings", kind === "team" ?
        {teamKey:Number(button.dataset.awardKey)} : {riderKey:Number(button.dataset.awardKey), finalGC:true}));
  }
  async function refreshOverviewCards() {
    const reqId = ++state.requestSeq.overview;
    const gcContainer = document.getElementById("overview-standings-container");
    const teamContainer = document.getElementById("overview-team-award-container");
    const donut = document.getElementById("stage-type-donut");
    const topRiders = document.getElementById("top-riders-chart");
    const topTeams = document.getElementById("top-teams-chart");
    const trend = document.getElementById("stage-trend-chart");
    updateScopeBanner();
    finalGCLeaders ??= apiPost("/api/analytics/rider_standings", {stage_scope:"final", classification:"gc", time_basis:"adjusted"})
      .then(data => data.rows.slice(0, 5))
      .catch(error => { finalGCLeaders = undefined; throw error; });
    finalTeamLeaders ??= apiPost("/api/analytics/team_standings", {stage_scope:"final", time_basis:"adjusted", rank_scope:"overall", team_aggregation:"stage_top3"})
      .then(data => data.rows.slice(0, 5))
      .catch(error => { finalTeamLeaders = undefined; throw error; });
    const stages = apiPost("/api/analytics/stage_summary", buildStageScopeOnlyFilters());
    const [leaders, teams, stageData] = await Promise.allSettled([finalGCLeaders, finalTeamLeaders, stages]);
    if (reqId !== state.requestSeq.overview) return;
    const riderRows = leaders.status === "fulfilled" ? leaders.value : [];
    const teamRows = teams.status === "fulfilled" ? teams.value : [];
    renderOverviewAward(gcContainer, riderRows, "rider");
    renderOverviewAward(teamContainer, teamRows, "team");
    if (topRiders) topRiders.innerHTML = RaceAppearance.rankingBarsMarkup(riderRows,"rider");
    if (topTeams) topTeams.innerHTML = RaceAppearance.rankingBarsMarkup(teamRows,"team");
    topRiders?.querySelectorAll("[data-overview-rider]").forEach(button => button.onclick = () => goToAnalysis("rider_standings", {riderKey:Number(button.dataset.overviewRider),finalGC:true}));
    topTeams?.querySelectorAll("[data-overview-team]").forEach(button => button.onclick = () => goToAnalysis("team_standings", {teamKey:Number(button.dataset.overviewTeam)}));
    if (donut) donut.innerHTML = stageData.status === "fulfilled" ? RaceAppearance.stageTypeDonutMarkup(stageData.value.rows || []) : '<p class="analysis-empty">Stage type data unavailable.</p>';
    if (trend) trend.innerHTML = stageData.status === "fulfilled" ? RaceAppearance.stageChartMarkup(stageData.value.rows || []) : '<p class="analysis-empty">Stage results unavailable.</p>';
  }

  function syncPageReturn() {
    const box = document.getElementById("page-return");
    if (!box) return;
    box.hidden = !pageTrail.length;
    const last = pageTrail.at(-1);
    if (last) document.getElementById("page-return-btn").textContent = "← " + (last.view === "overview" ? "Race overview" : MODULE_DESCRIPTIONS[last.module]?.title || "Previous view");
  }

  function rememberPage() {
    const controls = Array.from(document.getElementById("global-filter-form").querySelectorAll("input,select"), el => ({el,value:el.value,checked:el.checked}));
    const keys = ["selectedStageIds","selectedTeamKeys","selectedRiderKeys","multiTeamLock","multiRiderLock","explicitEmptyArrays"];
    pageTrail.push({view:state.activeView,module:state.activeExploreModule,controls,
      filters:Object.fromEntries(keys.map(k=>[k,structuredClone(state[k])])), scroll:window.scrollY,
      prefs:structuredClone(insightPreferences[state.activeExploreModule] || {})});
    syncPageReturn();
  }

  async function goToAnalysis(mod, preferences = {}, save = true) {
    if (save) rememberPage();
    Object.assign(insightPreferences[mod] ||= {}, preferences);
    state.activeStageDrillId = state.activeCountryDrillCode = null;
    switchWorkspaceView("explore", {skipRefresh:true});
    activateExploreModuleTab(mod, {skipRefresh:true});
    await refreshExplorerModule();
    if (state.activeView === "explore" && state.activeExploreModule === mod) scrollAndFocusElement(document.getElementById("workspace-heading"));
  }

  async function backToAnalysis() {
    const last = pageTrail.pop();
    if (!last) return;
    Object.assign(state,last.filters);
    last.controls.forEach(({el,value,checked})=>{el.value=value; if(el.type==="checkbox")el.checked=checked;});
    renderSelectedStagePills(); renderSelectedTeamPills(); renderSelectedRiderPills(); syncScopeControlVisibility(); updateScopeBanner();
    insightPreferences[last.module] = last.prefs;
    syncPageReturn();
    if (last.view === "overview") await switchWorkspaceView("overview");
    else await goToAnalysis(last.module, {}, false);
    window.scrollTo({top:last.scroll,behavior:"instant"});
  }

  function openMetricDrill(intent) {
    rememberPage();
    drillEntry = intent;
    switchWorkspaceView("drilldown", {skipRefresh:true});
    refreshDrilldownWorkspace(intent);
    scrollAndFocusElement(document.getElementById("workspace-heading"));
  }

  async function showAnalysisPage(mod, opts) {
    const request = ++state.requestSeq.explore;
    const isCurrent = () => request === state.requestSeq.explore && state.activeView === "explore" && state.activeExploreModule === mod;
    const host = document.getElementById("analysis-host");
    const element = document.createElement("div");
    host.hidden = false;
    host.replaceChildren(element);
    element.className = "analysis-sheet";
    element.innerHTML = '<p class="analysis-empty" role="status">Loading results…</p>';
    const filters = buildFilterPayload();
    const active = researchModules.includes(mod);
    document.getElementById("research-tabs").hidden = !active;
    document.querySelectorAll("#research-tabs button").forEach(button=>{
      if (button.dataset.openModule===mod) button.setAttribute("aria-current","page"); else button.removeAttribute("aria-current");
    });
    document.getElementById("workspace-heading").textContent = MODULE_DESCRIPTIONS[mod].title;
    host.closest(".explorer-card").classList.add("approved-layout");
    const read = async (prefix, name, selection) => (await apiPost("/api/"+prefix+"/"+name,selection ?? filters)).rows;
    try {
      await window.RacePages[mod]({element, filters, metadata:state.metadata, preferences:insightPreferences[mod] ||= {},
        isCurrent, analytics:(name,selection)=>read("analytics",name,selection), report:(name,selection)=>read("reports",name,selection),
        post:apiPost, go:goToAnalysis, drill:openMetricDrill});
      if (isCurrent() && opts.scroll) scrollAndFocusElement(document.getElementById("workspace-heading"));
    } catch (error) {
      if (isCurrent()) renderStateBox(element, "warning", "Results unavailable", error.message || "Try again.");
    }
  }

  function syncSidebarNavigation() {
    document.querySelectorAll(".portal-sidebar .rail-item").forEach(btn => {
      const active = btn.dataset.openModule ? state.activeView === "explore" && btn.dataset.openModule === state.activeExploreModule : btn.dataset.view === state.activeView;
      const selected = btn.dataset.exploration ? state.activeView === "explore" && researchModules.includes(state.activeExploreModule) : active;
      btn.classList.toggle("active", selected);
      if (selected) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
    });
  }

  function activateExploreModuleTab(modName, options) {
    const opts = options || {};
    state.activeExploreModule = (modName === "team_depth" && globalThis.RacePages?.team_standings) ? "team_standings" : modName || "rider_standings";
    configureInsightLayout(state.activeExploreModule);
    syncSidebarNavigation();
    Array.from(document.querySelectorAll(".module-tab-bar .module-tab")).forEach((t) => {
      t.classList.toggle("active", t.getAttribute("data-module") === state.activeExploreModule);
    });
    if (!opts.skipRefresh) {
      state.activeStageDrillId = null;
      state.activeCountryDrillCode = null;
      refreshExplorerModule();
    }
  }

  function configureInsightLayout(mod) {
    const isStory = INSIGHT_MODULES.includes(mod);
    const story = document.getElementById("insight-story");
    const table = document.getElementById("explore-table-container");
    const toggle = document.getElementById("insight-table-toggle");
    story?.classList.toggle("hidden", !isStory);
    story?.closest(".explorer-card")?.classList.toggle("has-story", isStory);
    table?.classList.toggle("hidden", isStory);
    toggle?.classList.toggle("hidden", !isStory);
    if (toggle) { toggle.setAttribute("aria-expanded", "false"); toggle.textContent = "Show data table"; }
    const label = document.getElementById("analysis-view-label");
    if (label) label.textContent = isStory ? "" : "Results";
    if (!isStory && story) { story.innerHTML = ""; story.onclick = story.onkeydown = story.onchange = null; }
  }

  async function refreshExplorerModule(options) {
    const opts = options || {};
    if (globalThis.RacePages?.[state.activeExploreModule]) return showAnalysisPage(state.activeExploreModule,opts);

    if (
      state.activeExploreModule === "stage_summary" &&
      state.activeStageDrillId !== null &&
      !opts.forceSummary
    ) {
      await openStageDetailDrill(state.activeStageDrillId, { scroll: Boolean(opts.scroll) });
      return;
    }
    if (
      state.activeExploreModule === "country_participation" &&
      state.activeCountryDrillCode !== null &&
      !opts.forceSummary
    ) {
      await openCountryMemberDrill(state.activeCountryDrillCode, {
        scroll: Boolean(opts.scroll),
      });
      return;
    }

    const reqId = ++state.requestSeq.explore;
    const container = document.getElementById("explore-table-container");
    const titleEl = document.getElementById("explore-module-title");
    const descEl = document.getElementById("explore-module-desc");
    const clsWrap = document.getElementById("explore-classification-wrap");
    const clsSelect = document.getElementById("explore-classification-select");

    const mod = state.activeExploreModule;
    configureInsightLayout(mod);
    const story = document.getElementById("insight-story");
    const isStory = INSIGHT_MODULES.includes(mod);
    if (isStory && story) story.innerHTML = '<div class="story-empty" role="status">Loading insights…</div>';
    const meta = MODULE_DESCRIPTIONS[mod] || MODULE_DESCRIPTIONS.rider_standings;
    const scopeDesc = getScopeDescriptor();

    if (titleEl) {
      // The active-scope chips and table caption carry scope; a stable module title
      // also avoids describing Points/KOM proxy scores as cumulative time.
      titleEl.textContent = meta.title;
      if (!titleEl.hasAttribute("tabindex")) {
        titleEl.setAttribute("tabindex", "-1");
      }
    }
    if (descEl) descEl.textContent = meta.desc;
    if (clsWrap) {
      clsWrap.classList.toggle("hidden", mod !== "rider_standings");
    }

    renderStateBox(
      container,
      "loading",
      "Loading Analytical View…",
      `Refreshing ${meta.title}…`
    );

    const overrides = {};
    if (mod === "rider_standings" && clsSelect) {
      overrides.classification = clsSelect.value;
    }
    const payload = buildFilterPayload(overrides);

    try {
      const resp = isStory
        ? await RaceInsights.load(mod, payload, apiPost)
        : await apiPost(`/api/analytics/${mod}`, payload);
      if (reqId !== state.requestSeq.explore) return;
      const rows = resp.rows || [];
      if (mod === "rider_standings") {
        renderRiderStandingsTable(container, rows, payload.classification || "gc", false);
      } else if (mod === "team_standings") {
        renderTeamStandingsTable(container, rows);
      } else if (mod === "stage_summary") {
        renderStageSummaryTable(container, rows);
      } else if (mod === "country_participation") {
        renderCountryParticipationTable(container, rows);
      } else if (mod === "rider_specialisation") {
        renderRiderSpecialisationTable(container, rows, {preservePage: opts.preservePage});
      } else if (mod === "gc_evolution") {
        renderGcEvolutionTable(container, rows);
      } else if (mod === "team_depth") {
        renderTeamDepthTable(container, rows);
      }

      if (isStory && story) {
        RaceInsights.mount({element: story, module: mod, data: resp, filters: payload,
          preferences: insightPreferences[mod] ||= {},
          onRider: (rider, team) => selectTeamForDrill(team, rider, {focusTarget: "rider", returnContext: captureReturnContext()}),
          onTeam: team => selectTeamForDrill(team, null, {focusTarget: "roster", returnContext: captureReturnContext()}),
          onStage: stage => openStageDetailDrill(stage, {scroll: true})});
      }
      if (opts.scroll) {
        scrollAndFocusElement(titleEl || container);
      }
    } catch (err) {
      if (reqId !== state.requestSeq.explore) return;
      renderStateBox(
        container,
        "warning",
        `Unable to Load ${meta.title}`,
        err.message || "Verify PostgreSQL connection and filter selection."
      );
      if (isStory && story) renderStateBox(story, "warning", "Insights unavailable", err.message || "Try again or adjust the filters.");
    }
  }

  /* --------------------------------------------------------------------------
     Independent 3-Level Drill Panel: Team -> Roster (incl. exits) -> Rider Stages
     -------------------------------------------------------------------------- */

  function updateDrillTeamSummaryStrip() {
    const strip = document.getElementById("drill-team-summary");
    if (!strip) return;
    if (!state.drillTeamKey) {
      strip.classList.add("hidden");
      return;
    }
    const standing = state.latestTeamStandings.find(
      (t) => Number(t.team_key) === Number(state.drillTeamKey)
    );
    const rosterCount = state.drillRosterRows.length;
    const finishersCount = state.drillRosterRows.filter(
      (r) => Number(r.finished_race_flag) === 1
    ).length;
    const exitedCount = rosterCount - finishersCount;

    strip.classList.remove("hidden");
    strip.innerHTML = `
      <div class="summary-metric">
        <span>Team Rank (${standing ? (standing.team_aggregation === "stage_top3" ? "Per-stage top 3" : "Cumulative top 3") : "Active scope"})</span>
        <strong>${standing ? `#${escapeHtml(standing.rank)} (${formatGap(standing.gap_seconds)})` : "Not Ranked in Scope"}</strong>
      </div>
      <div class="summary-metric">
        <span>Team Total Time</span>
        <strong>${standing ? formatDuration(standing.total_seconds) : "—"}</strong>
      </div>
      <div class="summary-metric">
        <span>Starting Roster</span>
        <strong>${rosterCount} riders (${finishersCount} fin · ${exitedCount} exit)</strong>
      </div>
    `;
  }

  async function selectTeamForDrill(teamKey, optionalRiderKey, options) {
    const opts = options || {};
    let resolvedTeamKey = teamKey;
    if (optionalRiderKey !== null && optionalRiderKey !== undefined) {
      const matchedRider = state.metadata.riders.find(
        (r) => Number(r.rider_key) === Number(optionalRiderKey)
      );
      if (matchedRider && matchedRider.team_key) {
        resolvedTeamKey = Number(matchedRider.team_key);
      }
    }
    ++state.requestSeq.riderStages;
    state.drillTeamKey = resolvedTeamKey;
    if (opts.returnContext) {
      state.inspectorReturnContext = opts.returnContext;
      updateInspectorReturnButton();
    }
    const drillSelect = document.getElementById("drill-team-select");
    if (drillSelect && resolvedTeamKey && String(drillSelect.value) !== String(resolvedTeamKey)) {
      drillSelect.value = String(resolvedTeamKey);
    }
    await loadTeamDrillRoster(resolvedTeamKey, optionalRiderKey, opts);
  }

  async function loadTeamDrillRoster(teamKey, preferredRiderKey, options) {
    const opts = options || {};
    const focusTarget = opts.focusTarget || null;
    const rosterContainer = document.getElementById("drill-roster-container");
    const stagesContainer = document.getElementById("drill-stages-container");
    const rosterHeading = document.getElementById("drill-roster-heading");

    const reqId = ++state.requestSeq.roster;
    ++state.requestSeq.riderStages;

    if (!teamKey) {
      renderStateBox(
        rosterContainer,
        "empty",
        "No Team Selected",
        "Select a team to view its roster."
      );
      return;
    }

    const teamMeta = state.metadata.teams.find(
      (t) => Number(t.team_key) === Number(teamKey)
    );
    if (rosterHeading) {
      rosterHeading.textContent = teamMeta
        ? `Team Roster: ${teamMeta.team_name} (${teamMeta.team_country_code || "Team"})`
        : "Team Roster & Available-Stage Contributions";
    }

    renderStateBox(
      rosterContainer,
      "loading",
      "Loading Full Team Roster…",
      "Loading starting roster and stage contributions…"
    );

    if (focusTarget) scrollAndFocusElement(rosterHeading || rosterContainer);
    const scopeFilters = buildStageScopeOnlyFilters();
    try {
      const resp = await apiPost(`/api/team/${teamKey}/riders`, scopeFilters);
      if (reqId !== state.requestSeq.roster || Number(state.drillTeamKey) !== Number(teamKey)) {
        return;
      }
      const rows = resp.rows || [];
      state.drillRosterRows = rows;
      updateDrillTeamSummaryStrip();

      if (rows.length === 0) {
        renderStateBox(
          rosterContainer,
          "empty",
          "No Team Members Match Filter",
          "No team members matched the active Young Rider / Rider filter."
        );
        renderStateBox(
          stagesContainer,
          "empty",
          "No Rider Selected",
          "Adjust filters or select a team member above."
        );
        if (focusTarget === "roster") {
          scrollAndFocusElement(
            document.getElementById("drill-roster-heading") ||
              document.getElementById("drill-roster-step")
          );
        }
        return;
      }

      const basisLabel =
        scopeFilters.time_basis === "finish"
          ? "Available Raw Time"
          : "Available Adj. Time";

      rosterContainer.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>Bib · Rider</th>
              <th>Nat.</th>
              <th>Race Status</th>
              <th class="num-col">Stages</th>
              <th class="num-col">${basisLabel}</th>
              <th class="num-col">Bonus / Pen</th>
              <th class="num-col">Pts / KOM Proxy</th>
              <th>Scope Attribution</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((r) => {
                const statusBadge =
                  Number(r.finished_race_flag) === 1
                    ? `<span class="chip chip-green">Finished (21/21)</span>`
                    : `<span class="chip chip-crimson">Exited Race</span>`;
                const youngBadge = r.is_young_rider
                  ? ` <span class="chip chip-navy">Young Rider</span>`
                  : "";
                const natCode = r.rider_country_code || "UNK";
                const natTitle = r.rider_country_name || "Unknown / Unspecified";
                const stagesRatio = `${escapeHtml(r.stages_completed)}/${escapeHtml(r.selected_stage_count)}`;
                const timeCell =
                  Number(r.stages_completed) > 0
                    ? formatDuration(r.selected_time_seconds)
                    : "—";
                const riderLabel = `#${r.bib_number} ${r.rider_name}`;
                return `
                  <tr class="clickable-row" data-rider-key="${escapeHtml(r.rider_key)}" aria-label="Inspect stage-by-stage results for ${escapeHtml(riderLabel)}" title="Click to load stage-by-stage results for ${escapeHtml(riderLabel)}">
                    <td>
                      <button type="button" class="table-link-btn" data-rider-key="${escapeHtml(r.rider_key)}" aria-label="Inspect stage-by-stage results for ${escapeHtml(riderLabel)}">
                        #${escapeHtml(r.bib_number)} ${escapeHtml(r.rider_name)}
                      </button>${youngBadge}
                    </td>
                    <td title="${escapeHtml(natTitle)}"><code>${escapeHtml(natCode)}</code></td>
                    <td>${statusBadge}</td>
                    <td class="num-col">${stagesRatio}</td>
                    <td class="num-col"><strong>${timeCell}</strong></td>
                    <td class="num-col">−${escapeHtml(r.time_bonus_seconds)}s / +${escapeHtml(r.time_penalty_seconds)}s</td>
                    <td class="num-col">${escapeHtml(r.stage_points_proxy)} / ${escapeHtml(r.kom_points_proxy)}</td>
                    <td><small>${escapeHtml(r.contribution_label)}</small></td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      `;

      Array.from(rosterContainer.querySelectorAll("tr.clickable-row")).forEach((tr) => {
        bindAccessibleRowAction(tr, () => {
          const rKey = parseInt(tr.getAttribute("data-rider-key"), 10);
          if (!Number.isNaN(rKey)) {
            Array.from(rosterContainer.querySelectorAll("tr.clickable-row")).forEach((row) =>
              row.classList.remove("selected-row")
            );
            tr.classList.add("selected-row");
            loadRiderStageDrill(rKey, { focusTarget: "rider" });
          }
        });
      });

      const targetRiderKey =
        preferredRiderKey ||
        (rows.some((r) => Number(r.rider_key) === Number(state.drillRiderKey))
          ? state.drillRiderKey
          : rows[0].rider_key);

      if (targetRiderKey) {
        const activeRow = rosterContainer.querySelector(
          `tr[data-rider-key="${targetRiderKey}"]`
        );
        if (activeRow) activeRow.classList.add("selected-row");
        await loadRiderStageDrill(targetRiderKey, {
          focusTarget: focusTarget === "rider" ? "rider" : null,
        });
        if (reqId !== state.requestSeq.roster || Number(state.drillTeamKey) !== Number(teamKey)) {
          return;
        }
      }

      if (focusTarget === "roster") {
        scrollAndFocusElement(
          document.getElementById("drill-roster-heading") ||
            document.getElementById("drill-roster-step")
        );
      }
    } catch (err) {
      if (reqId !== state.requestSeq.roster || Number(state.drillTeamKey) !== Number(teamKey)) {
        return;
      }
      renderStateBox(
        rosterContainer,
        "warning",
        "Unable to Load Team Roster",
        err.message || "Database connection unavailable."
      );
    }
  }

  async function loadRiderStageDrill(riderKey, options) {
    const opts = options || {};
    const focusTarget = opts.focusTarget || null;
    const expectedTeamKey = state.drillTeamKey;
    state.drillRiderKey = riderKey;
    const reqId = ++state.requestSeq.riderStages;
    const stagesContainer = document.getElementById("drill-stages-container");
    const headingEl = document.getElementById("drill-rider-heading");
    const subheadingEl = document.getElementById("drill-rider-subheading");

    const riderMeta =
      state.drillRosterRows.find((r) => Number(r.rider_key) === Number(riderKey)) ||
      state.metadata.riders.find((r) => Number(r.rider_key) === Number(riderKey));

    if (headingEl && riderMeta) {
      const natLabel =
        riderMeta.rider_country_code === "UNK"
          ? "UNK · Unknown / Unspecified"
          : `${riderMeta.rider_country_code} · ${riderMeta.rider_country_name || ""}`;
      headingEl.textContent = `Stage Results: #${riderMeta.bib_number} ${riderMeta.rider_name} (${natLabel})`;
    }
    if (subheadingEl && riderMeta) {
      subheadingEl.textContent =
        Number(riderMeta.finished_race_flag) === 1
          ? `Full-race finisher (${riderMeta.team_name}). Showing stage rank (ties permitted), raw/adjusted times, bonuses, penalties, and proxy points.`
          : `Exited race before Paris (${riderMeta.team_name}). Showing available completed stage results only — not eligible for full 21-stage GC.`;
    }

    renderStateBox(
      stagesContainer,
      "loading",
      "Loading Rider Stage Results…",
      "Loading completed stage results…"
    );
    if (focusTarget) scrollAndFocusElement(headingEl || stagesContainer);

    const stageFilters = buildStageScopeOnlyFilters();
    stageFilters.rider_keys = [Number(riderKey)];

    try {
      const resp = await apiPost("/api/analytics/rider_stage_results", stageFilters);
      if (
        reqId !== state.requestSeq.riderStages ||
        Number(state.drillRiderKey) !== Number(riderKey) ||
        state.drillTeamKey !== expectedTeamKey
      ) {
        return;
      }
      const rows = resp.rows || [];

      if (rows.length === 0) {
        renderStateBox(
          stagesContainer,
          "empty",
          "No Stage Results in Selected Scope",
          "This rider has no completed stage results within the currently selected stage filter."
        );
        if (focusTarget === "rider") {
          scrollAndFocusElement(
            document.getElementById("drill-rider-heading") ||
              document.getElementById("drill-rider-step")
          );
        }
        return;
      }

      stagesContainer.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>Stage · Date</th>
              <th>Stage Type</th>
              <th class="num-col">Dist.</th>
              <th class="num-col">Stage Rank (Ties Permitted)</th>
              <th class="num-col">Raw Time</th>
              <th class="num-col">Bonus / Pen</th>
              <th class="num-col">Adjusted Time</th>
              <th class="num-col">Stage Gap (Adj)</th>
              <th class="num-col">Pts / KOM Proxy</th>
              <th class="num-col">Percentile</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (s) => `
                <tr>
                  <td>
                    <strong>Stage ${escapeHtml(s.stage_id)}</strong>
                    <div><small>${escapeHtml(s.stage_date)} · ${escapeHtml(s.stage_name.replace(/^Stage \d+:\s*/, ""))}</small></div>
                  </td>
                  <td>${terrainChip(s.stage_type)}</td>
                  <td class="num-col">${formatKm(s.distance_km)}</td>
                  <td class="num-col rank-cell">
                    #${escapeHtml(s.finish_rank)} <small>/ ${escapeHtml(s.stage_finisher_count)}</small>
                  </td>
                  <td class="num-col">${formatDuration(s.finish_time_seconds)}</td>
                  <td class="num-col">−${escapeHtml(s.time_bonus_seconds)}s / +${escapeHtml(s.time_penalty_seconds)}s</td>
                  <td class="num-col"><strong>${formatDuration(s.adjusted_time_seconds)}</strong></td>
                  <td class="num-col">${formatGap(s.adjusted_gap_seconds)}</td>
                  <td class="num-col">${escapeHtml(s.stage_points_proxy)} / ${escapeHtml(s.kom_points_proxy)}</td>
                  <td class="num-col">${formatPercent(s.rank_percentile)}</td>
                </tr>
              `
              )
              .join("")}
          </tbody>
        </table>
      `;

      if (focusTarget === "rider") {
        scrollAndFocusElement(
          document.getElementById("drill-rider-heading") ||
            document.getElementById("drill-rider-step")
        );
      }
    } catch (err) {
      if (
        reqId !== state.requestSeq.riderStages ||
        Number(state.drillRiderKey) !== Number(riderKey) ||
        state.drillTeamKey !== expectedTeamKey
      ) {
        return;
      }
      renderStateBox(
        stagesContainer,
        "warning",
        "Unable to Load Rider Stage Results",
        err.message || "Database connection unavailable."
      );
    }
  }

  /* --------------------------------------------------------------------------
     Multi-Select Pills for Stages, Teams, and Riders
     -------------------------------------------------------------------------- */

  function renderSelectedStagePills() {
    const container = document.getElementById("selected-stages-pills");
    if (!container) return;
    if (state.explicitEmptyArrays.stage_ids && state.selectedStageIds.length === 0) {
      container.innerHTML = `<small class="label-hint">Explicit empty stage selection (0 stages)</small>`;
      return;
    }
    if (state.selectedStageIds.length === 0) {
      container.innerHTML = `<small class="label-hint">All stages matching checked stage types</small>`;
      return;
    }
    container.innerHTML = state.selectedStageIds
      .map(
        (id) => `
        <span class="stage-pill">
          Stage ${escapeHtml(id)}
          <button type="button" data-remove-stage="${escapeHtml(id)}" aria-label="Remove Stage ${escapeHtml(id)}">×</button>
        </span>
      `
      )
      .join("");

    Array.from(container.querySelectorAll("button[data-remove-stage]")).forEach((btn) => {
      btn.addEventListener("click", () => {
        const sId = parseInt(btn.getAttribute("data-remove-stage"), 10);
        state.selectedStageIds = state.selectedStageIds.filter((x) => x !== sId);
        state.explicitEmptyArrays.stage_ids = false;
        renderSelectedStagePills();
      });
    });
  }

  function renderSelectedTeamPills() {
    const container = document.getElementById("selected-teams-pills");
    const teamSelect = document.getElementById("filter-team-select");
    if (!container) return;
    if (state.selectedTeamKeys.length === 0) {
      container.innerHTML = "";
      if (teamSelect && teamSelect.value !== "") {
        teamSelect.value = "";
      }
      return;
    }
    if (teamSelect) {
      teamSelect.value = String(state.selectedTeamKeys[0]);
    }
    container.innerHTML = state.selectedTeamKeys
      .map((tKey) => {
        const meta = state.metadata.teams.find((t) => Number(t.team_key) === Number(tKey));
        const label = meta ? meta.team_name : `Team #${tKey}`;
        return `
          <span class="stage-pill" data-team-pill="${escapeHtml(tKey)}">
            ${escapeHtml(label)}
            <button type="button" data-remove-team="${escapeHtml(tKey)}" aria-label="Remove ${escapeHtml(label)}">×</button>
          </span>
        `;
      })
      .join("");

    Array.from(container.querySelectorAll("button[data-remove-team]")).forEach((btn) => {
      btn.addEventListener("click", () => {
        const tKey = parseInt(btn.getAttribute("data-remove-team"), 10);
        state.selectedTeamKeys = state.selectedTeamKeys.filter((x) => x !== tKey);
        if (state.selectedTeamKeys.length === 0) {
          state.multiTeamLock = false;
        }
        state.explicitEmptyArrays.team_keys = false;
        renderSelectedTeamPills();
      });
    });
  }

  function renderSelectedRiderPills() {
    const container = document.getElementById("selected-riders-pills");
    const riderSelect = document.getElementById("filter-rider-select");
    if (!container) return;
    if (state.selectedRiderKeys.length === 0) {
      container.innerHTML = "";
      if (riderSelect && riderSelect.value !== "") {
        riderSelect.value = "";
      }
      return;
    }
    if (riderSelect) {
      riderSelect.value = String(state.selectedRiderKeys[0]);
    }
    container.innerHTML = state.selectedRiderKeys
      .map((rKey) => {
        const meta = state.metadata.riders.find((r) => Number(r.rider_key) === Number(rKey));
        const label = meta ? `#${meta.bib_number} ${meta.rider_name}` : `Rider #${rKey}`;
        return `
          <span class="stage-pill" data-rider-pill="${escapeHtml(rKey)}">
            ${escapeHtml(label)}
            <button type="button" data-remove-rider="${escapeHtml(rKey)}" aria-label="Remove ${escapeHtml(label)}">×</button>
          </span>
        `;
      })
      .join("");

    Array.from(container.querySelectorAll("button[data-remove-rider]")).forEach((btn) => {
      btn.addEventListener("click", () => {
        const rKey = parseInt(btn.getAttribute("data-remove-rider"), 10);
        state.selectedRiderKeys = state.selectedRiderKeys.filter((x) => x !== rKey);
        if (state.selectedRiderKeys.length === 0) {
          state.multiRiderLock = false;
        }
        state.explicitEmptyArrays.rider_keys = false;
        renderSelectedRiderPills();
      });
    });
  }

  /* --------------------------------------------------------------------------
     Deliverable 5: Validated URL Deep-Link Contract
     -------------------------------------------------------------------------- */

  function parseMultiQueryValues(searchParams, key) {
    const rawValues = searchParams.getAll(key);
    const items = [];
    let explicitEmpty = false;
    rawValues.forEach((raw) => {
      const trimmed = String(raw || "").trim();
      if (trimmed === "") {
        // Ignore blank/whitespace-only values emitted by optional URL templates (e.g. `team_keys=`)
        return;
      }
      if (trimmed === "[]") {
        explicitEmpty = true;
        return;
      }
      trimmed.split(",").forEach((part) => {
        const cleaned = part.trim();
        if (cleaned === "[]") {
          explicitEmpty = true;
        } else if (cleaned !== "") {
          items.push(cleaned);
        }
      });
    });
    const hasExplicitEmpty = explicitEmpty && items.length === 0;
    return {
      present: items.length > 0 || hasExplicitEmpty,
      items,
      explicitEmpty: hasExplicitEmpty,
    };
  }

  function parseStrictPositiveInt(str) {
    if (!/^\d+$/.test(String(str || "").trim())) return null;
    const val = parseInt(String(str).trim(), 10);
    return !Number.isNaN(val) && val >= 1 ? val : null;
  }

  function parseAndApplyUrlDeepLink() {
    const rawSearch = window.location.search || "";
    if (!rawSearch || rawSearch === "?") {
      return { applied: false };
    }

    const searchParams = new URLSearchParams(rawSearch);
    const errors = [];
    const notices = [];
    const seenKeys = Array.from(new Set(Array.from(searchParams.keys())));

    seenKeys.forEach((key) => {
      if (!ALLOWED_URL_PARAM_KEYS.has(key)) {
        errors.push(`Unsupported URL parameter '${key}'`);
      }
    });

    const rawView = searchParams.get("view");
    const rawModule = searchParams.get("module");
    const rawDrill = searchParams.get("drill");
    const rawTab = searchParams.get("tab");
    const rawClassification = searchParams.get("classification");
    const rawStageScope = searchParams.get("stage_scope");
    const rawAsOfStage = searchParams.get("as_of_stage");
    const rawTimeBasis = searchParams.get("time_basis");
    const rawRankScope = searchParams.get("rank_scope");
    const rawTeamAgg = searchParams.get("team_aggregation");
    const rawYoungOnly = searchParams.get("young_only");

    let targetView = null;
    if (rawView !== null && rawView.trim() !== "") {
      const v = rawView.trim().toLowerCase();
      if (ALLOWED_VIEWS.includes(v)) {
        targetView = v;
      } else {
        errors.push(`Invalid view '${rawView}'`);
      }
    }

    let targetModule = null;
    if (rawModule !== null && rawModule.trim() !== "") {
      const m = rawModule.trim().toLowerCase();
      if (ALLOWED_MODULES.includes(m)) {
        targetModule = m;
      } else {
        errors.push(`Invalid module '${rawModule}'`);
      }
    }

    let targetDrill = null;
    if (rawDrill !== null && rawDrill.trim() !== "") {
      const d = rawDrill.trim().toLowerCase();
      if (ALLOWED_DRILLS.includes(d)) {
        targetDrill = d;
      } else {
        errors.push(`Invalid drill '${rawDrill}'`);
      }
    }

    let targetStageScope = null;
    if (rawStageScope !== null && rawStageScope.trim() !== "") {
      const sc = rawStageScope.trim().toLowerCase();
      if (ALLOWED_STAGE_SCOPES.includes(sc)) {
        targetStageScope = sc;
      } else {
        errors.push(`Invalid stage_scope '${rawStageScope}'`);
      }
    }

    let targetAsOfStage = null;
    if (rawAsOfStage !== null && rawAsOfStage.trim() !== "") {
      const parsedAsOf = parseStrictPositiveInt(rawAsOfStage);
      if (parsedAsOf !== null && parsedAsOf >= 1 && parsedAsOf <= 21) {
        targetAsOfStage = parsedAsOf;
      } else {
        errors.push(`Invalid as_of_stage '${rawAsOfStage}' (must be 1..21)`);
      }
    }

    let targetTimeBasis = null;
    if (rawTimeBasis !== null && rawTimeBasis.trim() !== "") {
      const tb = rawTimeBasis.trim().toLowerCase();
      if (ALLOWED_TIME_BASES.includes(tb)) {
        targetTimeBasis = tb;
      } else {
        errors.push(`Invalid time_basis '${rawTimeBasis}'`);
      }
    }

    let targetRankScope = null;
    if (rawRankScope !== null && rawRankScope.trim() !== "") {
      const rs = rawRankScope.trim().toLowerCase();
      if (ALLOWED_RANK_SCOPES.includes(rs)) {
        targetRankScope = rs;
      } else {
        errors.push(`Invalid rank_scope '${rawRankScope}'`);
      }
    }

    let targetTeamAgg = null;
    if (rawTeamAgg !== null && rawTeamAgg.trim() !== "") {
      const rawMethod = rawTeamAgg.trim().toLowerCase();
      const ta = ({ "per-stage top 3": "stage_top3", "cumulative top 3": "cumulative_top3" })[rawMethod] || rawMethod;
      if (ALLOWED_TEAM_AGGREGATIONS.includes(ta)) {
        targetTeamAgg = ta;
      } else {
        errors.push(`Invalid team_aggregation '${rawTeamAgg}'`);
      }
    }

    let targetClassification = null;
    if (rawClassification !== null && rawClassification.trim() !== "") {
      const cl = rawClassification.trim().toLowerCase();
      if (ALLOWED_CLASSIFICATIONS.includes(cl)) {
        targetClassification = cl;
      } else {
        errors.push(`Invalid classification '${rawClassification}'`);
      }
    }

    let targetYoungOnly = null;
    if (rawYoungOnly !== null && rawYoungOnly.trim() !== "") {
      const yo = rawYoungOnly.trim().toLowerCase();
      if (yo === "true" || yo === "1") {
        targetYoungOnly = true;
      } else if (yo === "false" || yo === "0") {
        targetYoungOnly = false;
      } else {
        errors.push(`Invalid young_only '${rawYoungOnly}'`);
      }
    }

    // Parse & validate array filters (both repeated keys and CSV strings)
    const stageIdsParsed = parseMultiQueryValues(searchParams, "stage_ids");
    const validatedStageIds = [];
    stageIdsParsed.items.forEach((token) => {
      const num = parseStrictPositiveInt(token);
      if (num !== null && num >= 1 && num <= 21) {
        if (!validatedStageIds.includes(num)) validatedStageIds.push(num);
      } else {
        errors.push(`Invalid stage_ids value '${token}'`);
      }
    });
    validatedStageIds.sort((a, b) => a - b);

    const stageTypesParsed = parseMultiQueryValues(searchParams, "stage_types");
    const validatedStageTypes = [];
    stageTypesParsed.items.forEach((token) => {
      const low = token.toLowerCase();
      if (ALLOWED_STAGE_TYPES.includes(low)) {
        if (!validatedStageTypes.includes(low)) validatedStageTypes.push(low);
      } else {
        errors.push(`Invalid stage_types value '${token}'`);
      }
    });

    const teamKeysParsed = parseMultiQueryValues(searchParams, "team_keys");
    const validatedTeamKeys = [];
    teamKeysParsed.items.forEach((token) => {
      const num = parseStrictPositiveInt(token);
      const existsInMeta =
        state.metadata.teams.length === 0 ||
        state.metadata.teams.some((t) => Number(t.team_key) === num);
      if (num !== null && existsInMeta) {
        if (!validatedTeamKeys.includes(num)) validatedTeamKeys.push(num);
      } else {
        errors.push(`Invalid team_keys value '${token}'`);
      }
    });

    const riderKeysParsed = parseMultiQueryValues(searchParams, "rider_keys");
    const validatedRiderKeys = [];
    riderKeysParsed.items.forEach((token) => {
      const num = parseStrictPositiveInt(token);
      const existsInMeta =
        state.metadata.riders.length === 0 ||
        state.metadata.riders.some((r) => Number(r.rider_key) === num);
      if (num !== null && existsInMeta) {
        if (!validatedRiderKeys.includes(num)) validatedRiderKeys.push(num);
      } else {
        errors.push(`Invalid rider_keys value '${token}'`);
      }
    });

    // Validate drill target parameters
    let drillStageId = null;
    let drillCountryCode = null;
    let drillTeamKey = null;
    let drillRiderKey = null;

    if (targetDrill === "stage") {
      const rawStageId = searchParams.get("stage_id");
      const parsedStageId =
        rawStageId !== null && rawStageId.trim() !== ""
          ? parseStrictPositiveInt(rawStageId)
          : validatedStageIds.length === 1
          ? validatedStageIds[0]
          : null;
      if (parsedStageId !== null && parsedStageId >= 1 && parsedStageId <= 21) {
        drillStageId = parsedStageId;
      } else {
        errors.push(
          `Invalid or missing stage_id '${rawStageId || ""}' for drill=stage (must be 1..21)`
        );
      }
    } else if (targetDrill === "country") {
      const rawCode = searchParams.get("country_code");
      const cleanedCode = String(rawCode || "").trim().toUpperCase();
      const validFormat =
        /^[A-Z]{3}$/.test(cleanedCode) &&
        cleanedCode !== "UNK" &&
        cleanedCode !== "NULL";
      const knownCountry =
        state.metadata.countries.length === 0 ||
        state.metadata.countries.some((c) => c.country_code === cleanedCode);
      if (validFormat && knownCountry) {
        drillCountryCode = cleanedCode;
      } else {
        errors.push(
          `Invalid or unknown country_code '${rawCode || ""}' for drill=country`
        );
      }
    } else if (targetDrill === "team") {
      const rawTKey = searchParams.get("team_key");
      const parsedTKey =
        rawTKey !== null && rawTKey.trim() !== ""
          ? parseStrictPositiveInt(rawTKey)
          : validatedTeamKeys.length === 1
          ? validatedTeamKeys[0]
          : null;
      const knownTeam =
        parsedTKey !== null &&
        (state.metadata.teams.length === 0 ||
          state.metadata.teams.some((t) => Number(t.team_key) === parsedTKey));
      if (knownTeam) {
        drillTeamKey = parsedTKey;
      } else {
        errors.push(`Invalid or unknown team_key '${rawTKey || ""}' for drill=team`);
      }
    } else if (targetDrill === "rider") {
      const rawRKey = searchParams.get("rider_key");
      const parsedRKey =
        rawRKey !== null && rawRKey.trim() !== ""
          ? parseStrictPositiveInt(rawRKey)
          : validatedRiderKeys.length === 1
          ? validatedRiderKeys[0]
          : null;
      const matchedRider =
        parsedRKey !== null
          ? state.metadata.riders.find((r) => Number(r.rider_key) === parsedRKey)
          : null;
      const knownRider =
        parsedRKey !== null &&
        (state.metadata.riders.length === 0 || Boolean(matchedRider));

      const rawTKey = searchParams.get("team_key");
      let parsedTKey = null;
      if (rawTKey !== null && rawTKey.trim() !== "") {
        parsedTKey = parseStrictPositiveInt(rawTKey);
        const validTeam =
          parsedTKey !== null &&
          (state.metadata.teams.length === 0 ||
            state.metadata.teams.some((t) => Number(t.team_key) === parsedTKey));
        if (!validTeam) {
          errors.push(`Invalid team_key '${rawTKey}' for drill=rider`);
        } else if (
          matchedRider &&
          matchedRider.team_key &&
          Number(matchedRider.team_key) !== parsedTKey
        ) {
          const actualTeamKey = Number(matchedRider.team_key);
          notices.push(
            `Normalized team_key=${parsedTKey} to #${matchedRider.bib_number} ${matchedRider.rider_name}'s actual team (${matchedRider.team_name}, team_key=${actualTeamKey})`
          );
          parsedTKey = actualTeamKey;
        }
      } else if (matchedRider && matchedRider.team_key) {
        parsedTKey = Number(matchedRider.team_key);
      } else if (state.drillTeamKey) {
        parsedTKey = Number(state.drillTeamKey);
      }

      if (knownRider && parsedTKey !== null) {
        drillRiderKey = parsedRKey;
        drillTeamKey = parsedTKey;
      } else if (!knownRider) {
        errors.push(`Invalid or unknown rider_key '${rawRKey || ""}' for drill=rider`);
      }
    }

    if (errors.length > 0) {
      showDeepLinkBanner(
        "Invalid Deep-Link Parameters Reset:",
        `${errors.join("; ")}. Showing safe default scope.`
      );
      if (targetDrill === "country") {
        return {
          applied: false,
          invalidCountryCode: searchParams.get("country_code") || "INVALID",
        };
      }
      if (targetDrill === "stage") {
        return {
          applied: false,
          invalidStageId: searchParams.get("stage_id") || "INVALID",
        };
      }
      return { applied: false };
    }

    if (notices.length > 0) {
      showDeepLinkBanner("Deep-Link Parameter Normalized:", notices.join("; "));
    } else {
      hideDeepLinkBanner();
    }

    // Apply validated filter controls to UI & state
    const scopeEl = document.getElementById("filter-stage-scope");
    const asOfEl = document.getElementById("filter-as-of-stage");
    const basisEl = document.getElementById("filter-time-basis");
    const rankScopeEl = document.getElementById("filter-rank-scope");
    const teamAggEl = document.getElementById("filter-team-aggregation");
    const youngOnlyEl = document.getElementById("filter-young-only");

    // Preserve full/as_of/selection intent:
    // Only infer stage_scope when stage_scope was not explicitly passed
    let effectiveStageScope = targetStageScope;
    if (!effectiveStageScope) {
      if (targetAsOfStage !== null) {
        effectiveStageScope = "as_of";
      } else if (
        stageIdsParsed.present ||
        stageTypesParsed.present
      ) {
        effectiveStageScope = "selection";
      } else {
        effectiveStageScope = "final";
      }
    }
    if (scopeEl) {
      scopeEl.value = effectiveStageScope;
    }

    if (targetAsOfStage !== null && asOfEl) {
      asOfEl.value = String(targetAsOfStage);
      const cap = document.getElementById("as-of-stage-caption");
      if (cap) cap.textContent = `Through Stage ${targetAsOfStage}`;
    }

    state.selectedStageIds = validatedStageIds;
    state.explicitEmptyArrays.stage_ids = stageIdsParsed.explicitEmpty;

    Array.from(document.querySelectorAll('input[name="stage_types"]')).forEach((cb) => {
      cb.checked = validatedStageTypes.includes(cb.value);
    });
    state.explicitEmptyArrays.stage_types = stageTypesParsed.explicitEmpty;

    if (targetTimeBasis && basisEl) basisEl.value = targetTimeBasis;
    if (targetRankScope && rankScopeEl) rankScopeEl.value = targetRankScope;
    if (targetTeamAgg && teamAggEl) teamAggEl.value = targetTeamAgg;
    if (targetYoungOnly !== null && youngOnlyEl) youngOnlyEl.checked = targetYoungOnly;

    if (targetClassification) {
      const ovCls = document.getElementById("overview-classification-select");
      const exCls = document.getElementById("explore-classification-select");
      if (ovCls) ovCls.value = targetClassification;
      if (exCls) exCls.value = targetClassification;
    }

    if (rawTab !== null && rawTab.trim() !== "") {
      const cleanedTab = rawTab.trim();
      const idxMatch = /^[1-5]$/.test(cleanedTab) ? parseInt(cleanedTab, 10) : null;
      if (idxMatch) {
        const tabMap = {
          1: "tab_1_overview",
          2: "tab_2_classifications",
          3: "tab_3_performance",
          4: "tab_4_countries",
          5: "tab_5_insights",
        };
        state.activeEmbedTabIndex = idxMatch;
        state.activeEmbedTabKey = tabMap[idxMatch];
      } else if (/^tab_[1-5]_/.test(cleanedTab)) {
        state.activeEmbedTabKey = cleanedTab;
      }
    }

    if (teamKeysParsed.present) {
      state.selectedTeamKeys = validatedTeamKeys;
      state.multiTeamLock = validatedTeamKeys.length > 1;
      state.explicitEmptyArrays.team_keys = teamKeysParsed.explicitEmpty;
      renderSelectedTeamPills();
      if (validatedTeamKeys.length > 0 && !drillTeamKey) {
        state.drillTeamKey = validatedTeamKeys[0];
      }
    }

    if (riderKeysParsed.present) {
      state.selectedRiderKeys = validatedRiderKeys;
      state.multiRiderLock = validatedRiderKeys.length > 1;
      state.explicitEmptyArrays.rider_keys = riderKeysParsed.explicitEmpty;
      renderSelectedRiderPills();
    }

    syncScopeControlVisibility();
    updateScopeBanner();

    if (targetModule === "rider_standings" && ALLOWED_CLASSIFICATIONS.includes(rawClassification)) {
      (insightPreferences.rider_standings ||= {}).classification = rawClassification;
    }
    if (targetModule) {
      activateExploreModuleTab(targetModule, { skipRefresh: true });
    }
    if (!targetView && targetModule) {
      targetView = "explore";
    }

    return {
      applied: true,
      view: targetView,
      module: targetModule,
      drill: targetDrill,
      stageId: drillStageId,
      countryCode: drillCountryCode,
      teamKey: drillTeamKey,
      riderKey: drillRiderKey,
    };
  }

  /* --------------------------------------------------------------------------
     UI Event Wiring
     -------------------------------------------------------------------------- */

  function syncScopeControlVisibility() {
    const scopeEl = document.getElementById("filter-stage-scope");
    const asOfGroup = document.getElementById("group-as-of-stage");
    const selGroup = document.getElementById("group-custom-selection");
    const scope = scopeEl ? scopeEl.value : "final";
    const caption = document.getElementById("as-of-stage-caption");
    if (caption) caption.textContent = `Through Stage ${document.getElementById("filter-as-of-stage")?.value || 21}`;

    if (asOfGroup) asOfGroup.classList.toggle("hidden", scope !== "as_of");
    if (selGroup) selGroup.classList.toggle("hidden", scope !== "selection");
    renderSelectedStagePills();
  }

  function switchWorkspaceView(viewName, options) {
    const opts = options || {};
    state.activeView = viewName;
    if (viewName !== "explore") state.requestSeq.explore++;
    syncSidebarNavigation();
    const views = {
      overview: document.getElementById("view-overview"),
      explore: document.getElementById("view-explore"),
      methods: document.getElementById("view-methods"),
      drilldown: document.getElementById("view-drilldown"),
    };
    Object.keys(views).forEach((k) => {
      if (views[k]) {
        views[k].classList.toggle("hidden", k !== viewName);
        views[k].classList.toggle("active", k === viewName);
      }
    });

    Array.from(document.querySelectorAll(".workspace-nav .nav-btn")).forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-view") === viewName);
    });

    const heading = document.getElementById("workspace-heading");
    if (heading) {
      heading.textContent = { overview: "Race overview", explore: "Explore the race", methods: "Methods & definitions", drilldown: "Drill Down" }[viewName] || "Race Analytics";
    }

    document.getElementById("inspector-details")?.classList.toggle("hidden", viewName === "drilldown");
    document.getElementById("open-inspector-btn")?.classList.toggle("hidden", viewName === "drilldown");
    if (!opts.skipRefresh) return refreshActiveView();
  }

  function refreshActiveView() {
    if (state.activeView === "overview") return Promise.all([refreshOverviewCards(), loadSignedEmbed()]);
    if (state.activeView === "explore") return refreshExplorerModule();
    if (state.activeView === "drilldown") return refreshDrilldownWorkspace();
  }

  async function refreshDrilldownWorkspace(intent) {
    if (!drilldownWorkspace) {
      drilldownWorkspace = RaceDrilldown.mount({
        element: document.getElementById("drill-workspace"), apiPost,
        getMetadata: async () => {
          if (!state.metadata.riders.length) await loadMetadata();
          return state.metadata;
        },
        getFilters: () => RaceDrilldown.mergeFilters(drillEntry?.baseFilters || buildFilterPayload(),drillEntry?.filters || {},state.metadata.stages),
        initialMetric:"top10",
      });
    }
    if (intent) drilldownWorkspace.enter(intent);
    await drilldownWorkspace.load();
  }

  async function applyAllFilters() {
    if (drillEntry?.baseFilters) delete drillEntry.baseFilters;
    updateScopeBanner();
    state.specialisationPage = 1;

    await refreshActiveView();
  }

  function renderRaceContext(meta) {
    const poster = document.querySelector(".race-poster");
    if (!poster) return;
    const data = RaceAppearance.raceSummary(meta);
    const values = {
      starters: data?.starters,
      teams: data?.teams,
      countries: data?.countries,
      stages: data?.stages,
      distance: data?.distance,
    };
    for (const [name, value] of Object.entries(values)) {
      poster.querySelector(`[data-race-value="${name}"]`).textContent =
        value == null ? "—" : value.toLocaleString("en-GB", {maximumFractionDigits:1});
    }
    poster.querySelector(".poster-starters").title = data ?
      `${data.finishers} finished · ${(100 * data.finishers / data.starters).toFixed(1)}% completion` :
      "Race context unavailable";
    if (data) document.getElementById("rail-race-context").textContent = `${data.starters} riders · ${data.stages} stages`;
    document.getElementById("poster-stage-link").onclick = () => goToAnalysis("stage_summary");
  }

  function openChartsForModule() {
    const disclosure = document.getElementById("bi-disclosure");
    if (disclosure) disclosure.open = true;
    const target = RaceAppearance.chartTabForModule(state.activeExploreModule);
    state.activeEmbedTabIndex = target.index;
    state.activeEmbedTabKey = target.key;
    switchWorkspaceView("overview");
    document.getElementById("back-to-table-btn")?.classList.remove("hidden");
    scrollAndFocusElement(document.getElementById("bi-workspace-title"));
  }

  function bindAppearance() {
    document.getElementById("page-return-btn")?.addEventListener("click",backToAnalysis);
    document.getElementById("bi-disclosure")?.addEventListener("toggle",event=>{if(event.target.open)loadSignedEmbed();else clearEmbedRefreshTimer();});
    document.getElementById("insight-table-toggle")?.addEventListener("click", () => {
      const btn = document.getElementById("insight-table-toggle");
      const open = btn.getAttribute("aria-expanded") !== "true";
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "Hide data table" : "Show data table";
      document.getElementById("explore-table-container").classList.toggle("hidden", !open);
    });
    document.getElementById("explore-charts-btn")?.addEventListener("click", openChartsForModule);
    document.getElementById("back-to-table-btn")?.addEventListener("click", () => {
      switchWorkspaceView("explore", {skipRefresh:true});
      refreshExplorerModule({scroll:true, preservePage:true});
    });
    const drawer = document.getElementById("filter-drawer");
    const form = document.getElementById("global-filter-form");
    let draft = null;
    const keys = ["selectedStageIds", "selectedTeamKeys", "selectedRiderKeys", "multiTeamLock", "multiRiderLock", "explicitEmptyArrays"];
    document.getElementById("open-filters-btn").addEventListener("click", () => {
      draft = { controls: Array.from(form.querySelectorAll("input,select")).map(el => ({el,value:el.value,checked:el.checked})), values: Object.fromEntries(keys.map(k => [k, structuredClone(state[k])])) };
      clearEmbedRefreshTimer();
      drawer.showModal();
    });
    document.getElementById("close-filters-btn").addEventListener("click", () => drawer.close("cancel"));
    drawer.addEventListener("cancel", ev => { ev.preventDefault(); drawer.close("cancel"); });
    drawer.addEventListener("close", () => {
      if (draft && drawer.returnValue !== "apply") {
        draft.controls.forEach(({el,value,checked}) => {el.value=value; if(el.type === "checkbox") el.checked=checked;});
        keys.forEach(k => {state[k]=draft.values[k];});
        renderSelectedTeamPills(); renderSelectedRiderPills(); syncScopeControlVisibility(); updateScopeBanner();
        // Refresh on return so an embed token cannot expire during a long edit.
        loadSignedEmbed();
      }
      draft = null;
    });
    document.getElementById("open-inspector-btn").addEventListener("click", () => scrollAndFocusElement(document.getElementById("drill-team-step")));
    document.querySelectorAll("[data-open-module]").forEach(btn => btn.addEventListener("click", () => {
      if (btn.dataset.finalStandings) {
        goToAnalysis("rider_standings",{finalGC:true,riderKey:null,classification:"gc",stageId:null});
        return;
      }
      pageTrail.length = 0; syncPageReturn();
      if (btn.dataset.openModule === "rider_standings" && btn.closest("#view-overview") && document.getElementById("overview-classification-select")) {
        document.getElementById("explore-classification-select").value = document.getElementById("overview-classification-select").value;
      }
      switchWorkspaceView("explore", {skipRefresh:true});
      activateExploreModuleTab(btn.dataset.openModule);
      scrollAndFocusElement(document.getElementById("workspace-heading"));
    }));
    const chart = document.getElementById("stage-trend-chart");
    const openPoint = ev => {
      const point = ev.target.closest("[data-stage-id]");
      if (!point || (ev.type === "keydown" && !["Enter", " "].includes(ev.key))) return;
      ev.preventDefault(); openStageDetailDrill(Number(point.dataset.stageId), {scroll:true});
    };
    chart.addEventListener("click", openPoint); chart.addEventListener("keydown", openPoint);
  }

  function bindEvents() {
    bindAppearance();
    Array.from(document.querySelectorAll(".workspace-nav .nav-btn")).forEach((btn) => {
      btn.addEventListener("click", () => {
        pageTrail.length=0; syncPageReturn();
        if(btn.dataset.view==="drilldown"){drillEntry=null;drilldownWorkspace?.enter({dimension:"team",path:[],metric:"top10"});}
        switchWorkspaceView(btn.getAttribute("data-view") || "overview");
        scrollAndFocusElement(document.getElementById("workspace-heading"));
      });
    });

    const switchExploreBtn = document.getElementById("switch-to-explore-btn");
    if (switchExploreBtn) {
      switchExploreBtn.addEventListener("click", () => switchWorkspaceView("explore"));
    }

    const dismissBannerBtn = document.getElementById("deeplink-banner-dismiss");
    if (dismissBannerBtn) {
      dismissBannerBtn.addEventListener("click", () => hideDeepLinkBanner());
    }

    const drillBackBtn = document.getElementById("drill-back-btn");
    if (drillBackBtn) {
      drillBackBtn.addEventListener("click", () => returnFromInspector());
    }

    const drillClearBtn = document.getElementById("drill-clear-btn");
    if (drillClearBtn) {
      drillClearBtn.addEventListener("click", () => clearInspectorDrill());
    }

    const scopeSelect = document.getElementById("filter-stage-scope");
    if (scopeSelect) {
      scopeSelect.addEventListener("change", () => {
        syncScopeControlVisibility();
        updateScopeBanner();
      });
    }

    const asOfSelect = document.getElementById("filter-as-of-stage");
    if (asOfSelect) {
      asOfSelect.addEventListener("change", () => {
        const cap = document.getElementById("as-of-stage-caption");
        if (cap) cap.textContent = `Through Stage ${asOfSelect.value}`;
      });
    }

    const addStageBtn = document.getElementById("add-stage-btn");
    if (addStageBtn) {
      addStageBtn.addEventListener("click", () => {
        const dropdown = document.getElementById("filter-stage-dropdown");
        if (!dropdown || !dropdown.value) return;
        const sId = parseInt(dropdown.value, 10);
        if (!Number.isNaN(sId) && !state.selectedStageIds.includes(sId)) {
          state.selectedStageIds.push(sId);
          state.selectedStageIds.sort((a, b) => a - b);
          state.explicitEmptyArrays.stage_ids = false;
          renderSelectedStagePills();
        }
      });
    }

    const filterTeamSelect = document.getElementById("filter-team-select");
    if (filterTeamSelect) {
      filterTeamSelect.addEventListener("change", () => {
        state.explicitEmptyArrays.team_keys = false;
        if (!filterTeamSelect.value) {
          state.selectedTeamKeys = [];
          state.multiTeamLock = false;
          renderSelectedTeamPills();
          return;
        }
        const tKey = parseInt(filterTeamSelect.value, 10);
        if (!Number.isNaN(tKey) && tKey >= 1) {
          if (!state.multiTeamLock) {
            state.selectedTeamKeys = [tKey];
            renderSelectedTeamPills();
          }
        }
      });
    }

    const addTeamBtn = document.getElementById("add-team-btn");
    if (addTeamBtn) {
      addTeamBtn.addEventListener("click", () => {
        if (!filterTeamSelect || !filterTeamSelect.value) return;
        const tKey = parseInt(filterTeamSelect.value, 10);
        if (!Number.isNaN(tKey) && tKey >= 1) {
          state.multiTeamLock = true;
          if (!state.selectedTeamKeys.includes(tKey)) {
            state.selectedTeamKeys.push(tKey);
          }
          state.explicitEmptyArrays.team_keys = false;
          renderSelectedTeamPills();
        }
      });
    }

    const filterRiderSelect = document.getElementById("filter-rider-select");
    if (filterRiderSelect) {
      filterRiderSelect.addEventListener("change", () => {
        state.explicitEmptyArrays.rider_keys = false;
        if (!filterRiderSelect.value) {
          state.selectedRiderKeys = [];
          state.multiRiderLock = false;
          renderSelectedRiderPills();
          return;
        }
        const rKey = parseInt(filterRiderSelect.value, 10);
        if (!Number.isNaN(rKey) && rKey >= 1) {
          if (!state.multiRiderLock) {
            state.selectedRiderKeys = [rKey];
            renderSelectedRiderPills();
          }
        }
      });
    }

    const addRiderBtn = document.getElementById("add-rider-btn");
    if (addRiderBtn) {
      addRiderBtn.addEventListener("click", () => {
        if (!filterRiderSelect || !filterRiderSelect.value) return;
        const rKey = parseInt(filterRiderSelect.value, 10);
        if (!Number.isNaN(rKey) && rKey >= 1) {
          state.multiRiderLock = true;
          if (!state.selectedRiderKeys.includes(rKey)) {
            state.selectedRiderKeys.push(rKey);
          }
          state.explicitEmptyArrays.rider_keys = false;
          renderSelectedRiderPills();
        }
      });
    }

    const filterForm = document.getElementById("global-filter-form");
    if (filterForm) {
      filterForm.addEventListener("submit", (ev) => {
        ev.preventDefault();
        document.getElementById("filter-drawer")?.close("apply");
        applyAllFilters();
      });
    }

    const resetBtn = document.getElementById("reset-filters-btn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        if (filterForm) filterForm.reset();
        state.selectedStageIds = [];
        state.selectedTeamKeys = [];
        state.selectedRiderKeys = [];
        state.multiTeamLock = false;
        state.multiRiderLock = false;
        state.explicitEmptyArrays = {
          stage_ids: false,
          stage_types: false,
          team_keys: false,
          rider_keys: false,
        };
        state.activeStageDrillId = null;
        state.activeCountryDrillCode = null;
        state.specialisationPage = 1;
        hideDeepLinkBanner();
        renderSelectedTeamPills();
        renderSelectedRiderPills();
        syncScopeControlVisibility();
        document.getElementById("filter-drawer")?.close("apply");
        applyAllFilters();
      });
    }

    const refreshEmbedBtn = document.getElementById("refresh-embed-btn");
    if (refreshEmbedBtn) {
      refreshEmbedBtn.addEventListener("click", () => loadSignedEmbed());
    }

    const overviewClsSelect = document.getElementById("overview-classification-select");
    if (overviewClsSelect) {
      overviewClsSelect.addEventListener("change", () => refreshOverviewCards());
    }

    const exploreClsSelect = document.getElementById("explore-classification-select");
    if (exploreClsSelect) {
      exploreClsSelect.addEventListener("change", () => refreshExplorerModule());
    }

    Array.from(document.querySelectorAll(".module-tab-bar .module-tab")).forEach((tab) => {
      tab.addEventListener("click", () => {
        const mod = tab.getAttribute("data-module") || "rider_standings";
        activateExploreModuleTab(mod);
      });
    });

    const drillTeamSelect = document.getElementById("drill-team-select");
    if (drillTeamSelect) {
      drillTeamSelect.addEventListener("change", () => {
        const tKey = parseInt(drillTeamSelect.value, 10);
        if (!Number.isNaN(tKey)) {
          selectTeamForDrill(tKey, null, {
            focusTarget: "roster",
            returnContext: captureReturnContext(),
          });
        }
      });
    }
  }

  async function initPortal() {
    bindEvents();
    syncScopeControlVisibility();
    updateScopeBanner();
    await Promise.all([loadHealth(), loadMetadata()]);

    const linkPlan = parseAndApplyUrlDeepLink();
    // Native BI deep links and on-page selections share the same evidence workspace.
    if (globalThis.RacePages && linkPlan.teamKey && ["team","rider"].includes(linkPlan.drill)) {
      const rider = linkPlan.drill === "rider" && linkPlan.riderKey;
      drillEntry = {dimension:"team", metric:rider?"results":"roster",
        path:rider?[linkPlan.teamKey,rider]:[linkPlan.teamKey]};
      switchWorkspaceView("drilldown",{skipRefresh:true});
      await refreshDrilldownWorkspace(drillEntry);
      scrollAndFocusElement(document.getElementById("drill-level-heading"));
      return;
    }

    // Legacy team/rider links target the inspector, which is intentionally hidden
    // in the dimension workspace. Keep these combinations visible in Overview.
    if (linkPlan.view === "drilldown" && ["team", "rider"].includes(linkPlan.drill)) {
      linkPlan.view = "overview";
    }


    if (linkPlan.invalidCountryCode || linkPlan.drill === "country") {
      return openCountryMemberDrill(linkPlan.invalidCountryCode || linkPlan.countryCode, {scroll:true});
    }
    if (linkPlan.invalidStageId || linkPlan.drill === "stage") {
      return openStageDetailDrill(linkPlan.invalidStageId || linkPlan.stageId, {scroll:true});
    }
    if (linkPlan.view) switchWorkspaceView(linkPlan.view, {skipRefresh:true});

    // Fallback for clients that still use the legacy inspector.
    if (linkPlan.applied && ["team","rider"].includes(linkPlan.drill)) {
      const showRider = linkPlan.drill === "rider";
      await Promise.all([refreshActiveView(), selectTeamForDrill(linkPlan.teamKey,
        showRider ? linkPlan.riderKey : null, {focusTarget:showRider ? "rider" : "roster"})]);
      return;
    }
    if (linkPlan.view === "explore") return refreshExplorerModule({scroll:true});
    await refreshActiveView();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPortal);
  } else {
    initPortal();
  }
})();

(function () {
  "use strict";

  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const count = value => Number(value || 0);
  const link = (action, value, label, extra = "") =>
    `<button type="button" class="country-link" data-action="${action}" data-value="${esc(value)}" ${extra}>${esc(label)}</button>`;
  const countryByCode = (rows, code) => rows.find(row => row.country_code === code);
  const memberFilters = filters => {
    const result = {};
    if (Array.isArray(filters.team_keys)) result.team_keys = filters.team_keys;
    if (Array.isArray(filters.rider_keys)) result.rider_keys = filters.rider_keys;
    if (filters.young_only) result.young_only = true;
    return result;
  };

  function chart(rows, key, title, kind) {
    const ranked = rows.filter(row => count(row[key]) > 0)
      .sort((a, b) => count(b[key]) - count(a[key]) || a.country_name.localeCompare(b.country_name))
      .slice(0, 8);
    const max = Math.max(1, ...ranked.map(row => count(row[key])));
    return `<section class="country-chart" aria-label="${esc(title)}">
      <h4>${esc(title)}</h4>
      <p>Top 8 · select a country to inspect its riders and results</p>
      ${ranked.map(row => `<button type="button" class="country-chart-row" data-action="open-country" data-value="${esc(row.country_code)}" aria-label="Inspect ${esc(row.country_name)}">
        <span class="country-chart-name" title="${esc(row.country_name)}">${esc(row.country_name)}</span>
        <span class="country-chart-track"><span class="country-chart-fill ${kind}" style="width:${Math.round(count(row[key]) / max * 100)}%"></span></span>
        <strong>${count(row[key])}</strong>
      </button>`).join("")}
    </section>`;
  }

  function overview(rows, state) {
    const knownRiders = rows.reduce((sum, row) => sum + count(row.rider_count), 0);
    const teams = rows.reduce((sum, row) => sum + count(row.team_count), 0);
    const examples = ["SLO", "UAE"].map(code => countryByCode(rows, code)).filter(Boolean);
    const key = state.countrySortKey || "rider_count";
    const desc = state.countrySortDesc !== false;
    const sorted = rows.slice().sort((a, b) => {
      const delta = ["country_name", "country_code"].includes(key)
        ? String(a[key]).localeCompare(String(b[key]))
        : count(a[key]) - count(b[key]);
      return (desc ? -delta : delta) || a.country_name.localeCompare(b.country_name);
    });
    const heading = (label, sortKey) => `<th scope="col"><button type="button" class="country-sort" data-action="sort" data-value="${sortKey}">${label}${key === sortKey ? (desc ? " ↓" : " ↑") : ""}</button></th>`;
    return `<div class="country-dashboard">
      <section class="analysis-block country-overview">
        <h3 tabindex="-1" data-overview-heading>Countries: participation and results</h3>
        <p class="country-intro"><strong>Two ways to group countries:</strong> riders by nationality and teams by registration country.</p>
        <div class="country-kpi-grid">
          <div><strong>${knownRiders}</strong><span>Riders with known nationality${knownRiders === 183 && teams === 23 ? " · 1 of 184 is unknown" : ""}</span></div>
          <div><strong>${teams}</strong><span>Registered teams</span></div>
          <div><strong>${rows.length}</strong><span>Countries with riders or teams</span></div>
        </div>
        <div class="country-chart-grid">
          ${chart(rows, "rider_count", "Riders by nationality", "riders")}
          ${chart(rows, "team_count", "Teams by registration country", "teams")}
        </div>
        ${examples.length === 2 ? `<div class="country-example">
          <strong>Nationality and team registration can differ</strong>
          <span>Open Slovenia, then follow a rider to the country where their team is registered.</span>
          ${examples.map(row => `<button type="button" data-action="open-country" data-value="${esc(row.country_code)}">${esc(row.country_name)} (${esc(row.country_code)}): ${count(row.rider_count)} national ${count(row.rider_count) === 1 ? "rider" : "riders"} · ${count(row.team_count)} registered ${count(row.team_count) === 1 ? "team" : "teams"} →</button>`).join("")}
        </div>` : ""}
      </section>
      <section class="analysis-block country-table-block">
        <h3>All countries</h3>
        <p>Participation covers the whole race. Stage wins and podiums follow the selected stages.</p>
        <div class="country-table-scroll"><table class="analysis-table">
          <thead><tr>${heading("Code", "country_code")}${heading("Country", "country_name")}${heading("Teams registered here", "team_count")}${heading("Riders from here", "rider_count")}${heading("Race finishers", "finisher_count")}${heading("Finisher rate", "finisher_rate")}${heading("Best national GC", "best_gc_rank")}${heading("National stage wins", "stage_wins")}${heading("National podiums", "podium_finishes")}</tr></thead>
          <tbody>${sorted.map(row => `<tr><td><code>${esc(row.country_code)}</code></td>
            <td>${link("open-country", row.country_code, row.country_name + " →")}</td>
            <td>${count(row.team_count)}</td><td>${count(row.rider_count)}</td><td>${count(row.finisher_count)}</td>
            <td>${row.finisher_rate == null || count(row.rider_count) === 0 ? "—" : (count(row.finisher_rate) * 100).toFixed(1) + "%"}</td>
            <td>${row.best_gc_rank == null ? "—" : "#" + esc(row.best_gc_rank)}</td>
            <td>${count(row.stage_wins)}</td><td>${count(row.podium_finishes)}</td></tr>`).join("")}</tbody>
        </table></div>
      </section>
    </div>`;
  }

  function detail(country, response, loading, error) {
    const rows = response?.rows || [];
    const summary = response?.summary || {};
    const national = rows.filter(row => row.is_rider_national || ["rider_nationality", "both"].includes(row.role_code));
    const registered = rows.filter(row => row.is_team_registered || ["team_registration", "both"].includes(row.role_code));
    const teams = [...new Map(registered.map(row => [row.team_key, row])).values()];
    const nationalCount = response ? count(summary.rider_national_count ?? national.length) : count(country.rider_count);
    const teamCount = response ? count(summary.registered_team_count ?? teams.length) : count(country.team_count);
    const rosterCount = response ? count(summary.registered_team_member_count ?? registered.length) : null;
    const unionCount = response ? count(summary.union_member_count ?? rows.length) : null;
    const bestRiders = Array.isArray(country.best_gc_riders) ? country.best_gc_riders : [];
    const podiumRows = Array.isArray(country.podium_rows) ? country.podium_rows : [];
    const code = country.country_code;
    const nationalPreview = national.length ? `<ul>${national.slice(0, 4).map(row => `<li>
      ${link("rider-drill", row.rider_key, row.rider_name + " →", `data-team-key="${esc(row.team_key)}"`)}
      <small>Races for ${link("team-drill", row.team_key, row.team_name + " →")} · registered in
      ${row.team_country_code && row.team_country_code !== code ? link("open-country", row.team_country_code, row.team_country_code + " →") : esc(code)}</small>
    </li>`).join("")}</ul>${national.length > 4 ? `<small>Showing 4 of ${national.length}; open the full list below.</small>` : ""}` :
      '<p>No rider of this nationality in the current selection.</p>';
    const teamPreview = teams.length ? `<ul>${teams.slice(0, 4).map(row =>
      `<li>${link("team-drill", row.team_key, row.team_name + " →")}</li>`).join("")}</ul>` :
      "<p>No team registered here. National riders may race for foreign-registered teams.</p>";
    const allRows = rows.map(row => `<tr>
      <td>${link("rider-drill", row.rider_key, "#" + row.bib_number + " " + row.rider_name + " →", `data-team-key="${esc(row.team_key)}"`)}</td>
      <td>${row.is_rider_national && row.is_team_registered ? "Both roles" : row.is_rider_national ? "Rider Nationality" : "Team Registration"}</td>
      <td>${esc(row.rider_country_code || "UNK")} ${esc(row.rider_country_name || "Unknown")}</td>
      <td>${link("team-drill", row.team_key, row.team_name + " (" + row.team_country_code + ") →")}</td>
      <td>${Number(row.finished_race_flag) === 1 ? "Finished (21/21)" : "Exited race"}</td>
    </tr>`).join("");
    return `<div class="country-dashboard">
      <section class="analysis-block country-detail">
        <header class="country-detail-top"><h3 tabindex="-1" data-country-heading>${esc(country.country_name)} (${esc(code)})</h3>
          <button type="button" class="country-back" data-action="back-countries">← Back to Country Participation</button></header>
        <div class="country-detail-stat-grid" aria-label="Country participation summary">
          <div class="country-detail-stat"><span>Riders of this nationality</span><strong>${nationalCount}</strong><small>Riders whose nationality is ${esc(code)}</small></div>
          <div class="country-detail-stat"><span>Teams registered here</span><strong>${teamCount}</strong><small>${rosterCount == null ? "Loading roster members…" : rosterCount + " riders on their rosters"}</small></div>
          <div class="country-detail-stat"><span>Unique riders linked to this country</span><strong>${unionCount == null ? "—" : unionCount}</strong><small>Nationality or team registration; each rider counted once</small></div>
        </div>
      </section>
      <section class="analysis-block country-member-preview" aria-label="Riders and teams by country">
        <h3>Riders and teams linked to ${esc(country.country_name)}</h3>
        <p>Riders are grouped by nationality; teams are grouped by registration country. The full list counts each person once.</p>
        ${loading ? '<p role="status">Loading country members…</p>' : error ? `<p role="alert">${esc(error)}</p>` :
        `<div class="country-preview-grid"><div><strong>${nationalCount} national ${nationalCount === 1 ? "rider" : "riders"}</strong>${nationalPreview}</div>
          <div><strong>${teamCount} registered ${teamCount === 1 ? "team" : "teams"}</strong>${teamPreview}</div></div>`}
      </section>
      ${response ? `<details class="analysis-block country-full-members"><summary>All related riders (${unionCount}) · nationality and team</summary>
        <div class="country-table-scroll"><table class="analysis-table"><thead><tr><th>Rider</th><th>Country membership role</th><th>Rider nationality</th><th>Team and registration</th><th>Race status</th></tr></thead>
        <tbody>${allRows}</tbody></table></div></details>` : ""}
      <section class="analysis-block country-outcomes" aria-label="Country race results">
        <h3>Race results for riders from ${esc(country.country_name)}</h3>
        <p>Results follow rider nationality, even when the team is registered elsewhere. GC (General Classification) is the overall rider ranking based on total adjusted time across all 21 stages; less time means a better rank. Best final GC rank shows the best overall position achieved by a full-race finisher of this nationality. Wins and podiums use the selected stages.</p>
        <div class="country-outcome-grid">
          <div><span>Best final GC rank</span><strong>${country.best_gc_rank == null ? "—" : "#" + esc(country.best_gc_rank)}</strong>
            <small>${bestRiders.length ? bestRiders.map(row => link("gc-rider", row.rider_key, row.rider_name + " →")).join(", ") : nationalCount === 0 ? "No national riders in this selection" : "No eligible full-race finisher"}</small></div>
          <div><span>Stage wins</span><strong>${count(country.stage_wins)}</strong><small>Rank 1 stage finishes</small></div>
          <div><span>Podium finishes</span><strong>${count(country.podium_finishes)}</strong><small>Rank 1–3 stage finishes</small></div>
        </div>
        <details class="country-evidence"><summary>Open the ${podiumRows.length} stage results behind these counts</summary>
          ${podiumRows.length ? `<div class="country-table-scroll"><table class="analysis-table"><thead><tr><th>Stage</th><th>Place</th><th>Rider</th><th>Team</th></tr></thead>
            <tbody>${podiumRows.map(row => `<tr><td>${link("stage-evidence", row.stage_id, "Stage " + row.stage_id + " →", `data-rider-key="${esc(row.rider_key)}"`)} <small>${esc(row.stage_type)}</small></td>
              <td>#${esc(row.finish_rank)}</td><td>${esc(row.rider_name)}</td><td>${esc(row.team_name)}</td></tr>`).join("")}</tbody></table></div>` :
              "<p>No podium result in the selected stages.</p>"}</details>
      </section>
    </div>`;
  }

  async function countryDashboard(ctx) {
    const [outcomes, participation] = await Promise.all([
      ctx.report("country_outcomes"),
      ctx.analytics("country_participation"),
    ]);
    if (!ctx.isCurrent()) return;
    const participationByCode = new Map(participation.map(row => [row.country_code, row]));
    const rows = outcomes.map(row => ({...row, ...participationByCode.get(row.country_code)}));
    const root = ctx.element;
    const cache = new Map();
    let detailCode = countryByCode(rows, ctx.preferences.countryCode)?.country_code || null;
    let loading = false;
    let error = "";

    const draw = () => {
      const country = countryByCode(rows, detailCode);
      root.innerHTML = country ? detail(country, cache.get(detailCode), loading, error) : overview(rows, ctx.preferences);
    };
    const open = async (code, focus = true) => {
      if (!countryByCode(rows, code)) return;
      detailCode = ctx.preferences.countryCode = code;
      error = "";
      loading = !cache.has(code);
      draw();
      if (loading) {
        try {
          const response = await ctx.post(`/api/country/${encodeURIComponent(code)}/members`, memberFilters(ctx.filters));
          if (!ctx.isCurrent() || detailCode !== code) return;
          cache.set(code, response);
        } catch (err) {
          if (!ctx.isCurrent() || detailCode !== code) return;
          error = err?.message || "Country members could not be loaded.";
        }
        loading = false;
        draw();
      }
      if (focus) root.querySelector("[data-country-heading]")?.focus();
    };
    root.onclick = async event => {
      const button = event.target.closest("[data-action]");
      if (!button || !ctx.isCurrent()) return;
      const {action, value} = button.dataset;
      if (action === "open-country") return open(value);
      if (action === "back-countries") {
        detailCode = ctx.preferences.countryCode = null;
        draw();
        root.querySelector("[data-overview-heading]")?.focus();
        return;
      }
      if (action === "sort") {
        ctx.preferences.countrySortDesc = ctx.preferences.countrySortKey === value ? !ctx.preferences.countrySortDesc : !["country_name", "country_code", "best_gc_rank"].includes(value);
        ctx.preferences.countrySortKey = value;
        draw();
        return;
      }
      const country = countryByCode(rows, detailCode);
      if (!country) return;
      if (action === "gc-rider") return ctx.go("rider_standings", {riderKey:Number(value),finalGC:true});
      if (action === "stage-evidence") return ctx.go("stage_summary", {stageMode:"order",stageId:Number(value),stageRiderKey:Number(button.dataset.riderKey),stageTeamKey:null,stageFull:false});
      if (action === "team-drill") return ctx.drill({dimension:"country",role:"registration",path:[detailCode,Number(value)],metric:"roster",label:`${country.country_name} · registered team`});
      if (action === "rider-drill") {
        const row = cache.get(detailCode)?.rows?.find(item => Number(item.rider_key) === Number(value));
        if (!row) return;
        const role = row.is_rider_national ? "nationality" : "registration";
        const path = role === "nationality" ? [detailCode,Number(value)] : [detailCode,Number(row.team_key),Number(value)];
        return ctx.drill({dimension:"country",role,path,metric:"roster",label:`${country.country_name} · ${row.rider_name}`});
      }
    };
    if (detailCode) await open(detailCode, false);
    else draw();
  }

  window.RacePages = window.RacePages || {};
  window.RacePages.country_participation = countryDashboard;
})();

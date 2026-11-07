(function(){
  "use strict";

  const esc = value => String(value ?? "—").replace(/[&<>"']/g, ch => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
  })[ch]);
  const n = value => Number(value);
  const empty = message => `<p class="analysis-empty">${esc(message)}</p>`;
  const note = message => `<p class="analysis-note">${esc(message)}</p>`;
  const head = title => `<h3 class="analysis-title">${esc(title)}</h3>`;
  const stageTypeName = value => value === "individual time-trial" ? "Individual Time Trial" :
    String(value ?? "").replace(/^./, first => first.toUpperCase());
  const route = stage => `${stage.start_location_name} → ${stage.finish_location_name}`;
  const clock = seconds => {
    if (seconds == null || !Number.isFinite(n(seconds))) return "—";
    const total = Math.round(n(seconds));
    return `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  };

  function button(action, value, label, options = {}) {
    const cls = options.className || "analysis-link";
    const metric = options.metric ? ` data-metric="${esc(options.metric)}"` : "";
    const pressed = options.pressed == null ? "" : ` aria-pressed="${Boolean(options.pressed)}"`;
    const title = options.label ? ` aria-label="${esc(options.label)}"` : "";
    return `<button class="${esc(cls)}" type="button" data-action="${esc(action)}" data-value="${esc(value)}"${metric}${pressed}${title}>${esc(label)}</button>`;
  }

  function table(headers, rows, name, caption) {
    return `<div class="analysis-table-wrap route-table-scroll" data-scroll="${esc(name)}" tabindex="0" role="region" aria-label="${esc(caption)}"><table class="analysis-table" aria-label="${esc(caption)}"><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  }

  function mount(ctx) {
    ctx.element.innerHTML = '<div class="analysis-page route-page" data-route-page></div>';
    return ctx.element.querySelector("[data-route-page]");
  }

  function paint(root, html) {
    const active = root.ownerDocument?.activeElement;
    const focused = active && root.contains(active) && active.dataset.action ? {...active.dataset} : null;
    const scrolls = new Map(Array.from(root.querySelectorAll("[data-scroll]"), box =>
      [box.dataset.scroll, [box.scrollTop, box.scrollLeft]]));
    root.innerHTML = html;
    for (const box of root.querySelectorAll("[data-scroll]")) {
      const previous = scrolls.get(box.dataset.scroll);
      if (previous) [box.scrollTop, box.scrollLeft] = previous;
    }
    if (focused) {
      const next = Array.from(root.querySelectorAll("[data-action]")).find(b =>
        b.dataset.action === focused.action && b.dataset.value === focused.value && b.dataset.metric === focused.metric);
      next?.focus({preventScroll:true});
    }
  }

  function focusEvidence(root) {
    root.querySelector("[data-evidence-heading]")?.focus();
  }

  function stageList(stages, mode, types, order) {
    const list = stages.filter(row => !types.length || types.includes(row.stage_type));
    return list.sort((a,b) => {
      if (order?.key === "date") {
        const compared = String(a.stage_date).localeCompare(String(b.stage_date));
        if (compared) return order.desc ? -compared : compared;
      }
      if (order?.key === "distance") {
        const compared = n(a.distance_km) - n(b.distance_km);
        if (compared) return order.desc ? -compared : compared;
      }
      return (mode === "longest" ? n(b.distance_km) - n(a.distance_km) : 0)
        || n(a.stage_order) - n(b.stage_order);
    });
  }

  function sortHeading(key, label, order) {
    const sorted = order?.key === key;
    return `<th scope="col"${sorted ? ` aria-sort="${order.desc ? "descending" : "ascending"}"` : ""}>${button(
      "stage-sort", key, `${label}${sorted ? (order.desc ? " ↓" : " ↑") : ""}`,
      {className:"route-sort", label:`Sort by ${label}`}
    )}</th>`;
  }

  function directoryMarkup(stages, mode, spotlightId, types, order, allStages, typeMenuOpen) {
    const options = [["order","Stage Order"],["longest","Longest Routes"]];
    const stageTypes = [...new Set(allStages.map(s => s.stage_type))].sort((a,b) => stageTypeName(a).localeCompare(stageTypeName(b)));
    const typeLabel = !types.length ? "All Stage Types" : types.length === 1 ? stageTypeName(types[0]) : `${types.length} Stage Types`;
    const directoryRows = stages.map(s => `<tr${n(s.stage_id) === spotlightId ? ' class="route-selected"' : ""}>
      <td>${button("choose-stage", s.stage_id, `Stage ${s.stage_id}`, {pressed:n(s.stage_id) === spotlightId, label:`Open stage ${s.stage_id}, ${route(s)}`})}</td>
      <td>${esc(s.start_location_name)}</td><td>${esc(s.finish_location_name)}</td><td>${esc(s.stage_date)}</td><td>${esc(stageTypeName(s.stage_type))}</td>
      <td>${esc(n(s.distance_km))}</td><td>${esc((s.winner_names || []).join(", ") || "—")}</td></tr>`);
    const headers = ["Stage","Start Location","Finish Location",sortHeading("date","Date",order),"Type",sortHeading("distance","Distance (km)",order),"Stage Winner"];
    const headerMarkup = headers.map(h => h.startsWith?.("<th") ? h : `<th scope="col">${esc(h)}</th>`).join("");
    return `<section class="analysis-block"><header class="analysis-head">${head("Route Directory")}
      <div class="route-directory-controls"><details class="route-type-filter" data-route-type-filter${typeMenuOpen ? " open" : ""}><summary aria-label="Filter routes by stage type">${esc(typeLabel)}</summary>
        <div class="route-type-menu" role="group" aria-label="Stage types"><label><input type="checkbox" data-action="stage-type" value=""${types.length ? "" : " checked"}> All Stage Types</label>
        ${stageTypes.map(value => `<label><input type="checkbox" data-action="stage-type" value="${esc(value)}"${types.includes(value) ? " checked" : ""}> ${esc(stageTypeName(value))}</label>`).join("")}</div>
      </details><div class="analysis-segment route-modes" role="group" aria-label="Route views">${options.map(([k,label]) =>
        button("stage-mode", k, label, {className:"route-option",pressed:k===mode && !order?.key})).join("")}</div></div></header>
      ${directoryRows.length ? `<div class="analysis-table-wrap route-table-scroll" data-scroll="directory" tabindex="0" role="region" aria-label="Route Directory"><table class="analysis-table" aria-label="Route Directory"><thead><tr>${headerMarkup}</tr></thead><tbody>${directoryRows.join("")}</tbody></table></div>` :
        empty("No stages match this route view and stage types.")}</section>`;
  }

  function stageDetails(stage, rows, state, loading, error) {
    const intro = `<header class="analysis-head"><div><h3 class="analysis-title" data-evidence-heading tabindex="-1">Stage ${esc(stage.stage_id)} · ${esc(route(stage))}</h3>
      ${note(`${stage.stage_date} · ${stageTypeName(stage.stage_type)} · ${n(stage.distance_km)} km`)}</div></header>`;
    if (loading) return intro + '<p role="status" class="analysis-note">Loading stage results…</p>';
    if (error) return intro + empty(error) + button("retry-stage","","Retry stage results");
    if (!rows.length) return intro + empty("No stage results match the current rider and team filters.");

    const top = rows.filter(row => n(row.finish_rank) <= 10);
    const teams = new Map();
    for (const row of top) {
      const key = n(row.team_key);
      const team = teams.get(key) || {key, name:row.team_name, count:0};
      team.count++;
      teams.set(key,team);
    }
    const counts = [...teams.values()].sort((a,b) => b.count-a.count || a.name.localeCompare(b.name));
    const teamKey = n(state.stageTeamKey);
    const chosenTeam = teams.get(teamKey);
    const shown = state.stageFull ? rows : top;
    const resultRows = shown.map(row => `<tr${chosenTeam && n(row.team_key) === teamKey && n(row.finish_rank) <= 10 ? ' class="route-contributor"' : ""}>
      <td>${esc(row.finish_rank)}</td><td>${esc(row.bib_number)}</td>
      <td>${button("stage-rider",row.rider_key,row.rider_name,{label:`${row.rider_name}, view stage result`,pressed:n(state.stageRiderKey)===n(row.rider_key)})}</td>
      <td>${esc(row.team_name)}</td><td class="route-time">${clock(row.finish_time_seconds)}</td>
      <td class="route-time">${clock(row.adjusted_time_seconds)}</td></tr>`);
    const bars = counts.map(team =>
      `<button type="button" class="route-team-bar" data-action="team" data-value="${esc(team.key)}" aria-pressed="${team.key===teamKey}" aria-label="${esc(team.name)}, highlight ${esc(team.count)} top-ten results">
        <span class="route-bar-label">${esc(team.name)}<strong>${esc(team.count)}</strong></span><span class="route-bar-track"><span style="width:${100*team.count/counts[0].count}%"></span></span></button>`).join("");
    const person = shown.find(row => n(row.rider_key) === n(state.stageRiderKey));
    const riderDetail = person ? `<div class="route-fact"><h4 tabindex="-1" data-rider-heading>#${esc(person.bib_number)} · ${esc(person.rider_name)}</h4>
      ${note(`${person.team_name} · Source rank ${person.finish_rank}`)}
      <p>Finish ${clock(person.finish_time_seconds)} · Bonus ${esc(person.time_bonus_seconds)} s · Penalty ${esc(person.time_penalty_seconds)} s · Adjusted ${clock(person.adjusted_time_seconds)}</p>
      ${button("trend",person.rider_key,"Rider trend")}</div>` : "";
    return `${intro}<div class="route-results-grid"><section><div class="analysis-head"><h4>${state.stageFull ? "All Matching Finishers" : "Top-Ten Finishers"}</h4>
      ${button("full-stage","",state.stageFull ? "Show Top Ten" : `Full Stage (${rows.length})`,{pressed:!!state.stageFull})}</div>
      ${resultRows.length ? table(["Rank","Bib","Rider","Team","Finish Time","Adjusted Time"],resultRows,state.stageFull ? "stage-results" : "stage-top-ten","Stage Results by source rank") : empty("No matching riders finished in the source top ten.")}
      ${riderDetail}</section><section><h4>Top-Ten Places by Team</h4>${bars || empty("No matching top-ten results.")}
      ${chosenTeam ? `<div class="route-fact">${note(`${chosenTeam.name} · ${chosenTeam.count} highlighted`)}${button("team-evidence",teamKey,"Open Top-Ten Evidence")}</div>` : ""}</section></div>`;
  }

  async function stagesPage(ctx) {
    const stages = await ctx.report("route_directory");
    if (!ctx.isCurrent()) return;
    const root = mount(ctx), state = ctx.preferences, cache = new Map();
    let seq = 0, loading = false, error = "";
    let mode = ["order","longest"].includes(state.stageMode) ? state.stageMode : "order";
    const validTypes = new Set(stages.map(s => s.stage_type));
    let types = Array.isArray(state.stageTypes) ? [...new Set(state.stageTypes.filter(value => validTypes.has(value)))] :
      (validTypes.has(state.stageType) ? [state.stageType] : []);
    if (types.length && stages.some(s => n(s.stage_id) === n(state.stageId) && !types.includes(s.stage_type))) types = [];
    let order = ["date","distance"].includes(state.stageSort?.key) ? state.stageSort : null;
    let typeMenuOpen = false;
    state.stageMode = mode;
    state.stageTypes = types;
    state.stageType = types.length === 1 ? types[0] : "";
    state.stageSort = order;
    let list = stageList(stages,mode,types,order);
    let selected = list.find(s => n(s.stage_id) === n(state.stageId)) || list[0];
    let spotlightId = mode === "longest" && selected ? n(selected.stage_id) : null;
    if (selected && n(state.stageId) !== n(selected.stage_id)) resetStage(selected);
    let rows = [];

    function resetStage(stage) {
      state.stageId = stage ? n(stage.stage_id) : null;
      state.stageRiderKey = null;
      state.stageTeamKey = null;
      state.stageFull = false;
    }
    function draw() {
      const currentTypeMenu = root.querySelector("[data-route-type-filter]");
      if (currentTypeMenu) typeMenuOpen = currentTypeMenu.open;
      const details = selected ? `<section class="analysis-block">${stageDetails(selected,rows,state,loading,error)}</section>` : "";
      paint(root, directoryMarkup(list,mode,spotlightId,types,order,stages,typeMenuOpen) + details);
    }
    async function loadStage(moveFocus = false) {
      const request = ++seq;
      rows = [];
      error = "";
      if (!selected) { loading = false; draw(); return; }
      const stageId = n(selected.stage_id);
      state.stageId = stageId;
      if (!cache.has(stageId)) {
        loading = true;
        draw();
        try {
          const filters = {...ctx.filters, stage_scope:"selection", stage_ids:[stageId]};
          const data = await ctx.analytics("rider_stage_results", filters);
          if (!ctx.isCurrent() || request !== seq) return;
          cache.set(stageId, data.slice().sort((a,b) => n(a.finish_rank)-n(b.finish_rank) || n(a.bib_number)-n(b.bib_number)));
        } catch (err) {
          if (!ctx.isCurrent() || request !== seq) return;
          error = err?.message || "The stage results could not be loaded.";
        }
      }
      rows = cache.get(stageId) || [];
      loading = false;
      draw();
      if (moveFocus) focusEvidence(root);
    }

    root.onclick = async event => {
      const b = event.target.closest("button[data-action]");
      if (!b || !ctx.isCurrent()) return;
      const {action,value} = b.dataset;
      if (action === "stage-mode") {
        mode = state.stageMode = value;
        order = state.stageSort = null;
        list = stageList(stages,mode,types,order);
        selected = list[0];
        spotlightId = mode === "longest" && selected ? n(selected.stage_id) : null;
        resetStage(selected);
        const box = root.querySelector('[data-scroll="directory"]');
        if (box) box.scrollTop = 0;
        return loadStage();
      }
      if (action === "stage-sort") {
        order = state.stageSort = order?.key === value ? {key:value,desc:!order.desc} : {key:value,desc:value === "distance"};
        list = stageList(stages,mode,types,order);
        selected = list.find(s => n(s.stage_id) === n(state.stageId)) || list[0];
        resetStage(selected);
        return loadStage();
      }
      if (action === "choose-stage") {
        selected = list.find(s => n(s.stage_id) === n(value));
        spotlightId = selected ? n(selected.stage_id) : null;
        resetStage(selected);
        return loadStage(true);
      }
      if (action === "retry-stage") return loadStage();
      if (action === "trend") return ctx.go("gc_evolution",{riderKey:n(value)});
      if (action === "team-evidence") return ctx.drill({
        dimension:"team", path:[n(value)], metric:"top10",
        filters:{stage_scope:"selection",stage_ids:[n(selected.stage_id)]},
        label:`Stage ${selected.stage_id} · Top-ten places`,
      });
      if (action === "team") state.stageTeamKey = n(state.stageTeamKey) === n(value) ? null : n(value);
      if (action === "full-stage") state.stageFull = !state.stageFull;
      if (action === "stage-rider") state.stageRiderKey = n(state.stageRiderKey) === n(value) ? null : n(value);
      draw();
      if (action === "stage-rider" && state.stageRiderKey) root.querySelector("[data-rider-heading]")?.focus();
    };
    root.onchange = event => {
      const checkbox = event.target.closest('input[data-action="stage-type"]');
      if (!checkbox || !ctx.isCurrent()) return;
      typeMenuOpen = checkbox.closest("details")?.open ?? true;
      if (!checkbox.value && checkbox.checked) types = [];
      else if (checkbox.value) types = checkbox.checked ? [...new Set([...types,checkbox.value])] : types.filter(value => value !== checkbox.value);
      state.stageTypes = types;
      state.stageType = types.length === 1 ? types[0] : "";
      list = stageList(stages,mode,types,order);
      selected = list[0];
      spotlightId = mode === "longest" && selected ? n(selected.stage_id) : null;
      resetStage(selected);
      return loadStage();
    };
    await loadStage();
  }

  const views = {
    participation: [["rider_count","National riders"],["team_count","Registered teams"]],
    results: [["best_gc_rank","Best final GC"],["best_name","Best GC rider"],["stage_wins","Stage wins"],["podium_finishes","Podium places"]],
  };
  const labels = {rider_count:"National riders",team_count:"Registered teams",best_gc_rank:"Best final GC",
    stage_wins:"Stage wins",podium_finishes:"Podium places"};
  const bestNames = c => (c.best_gc_riders || []).map(r => r.rider_name).join(", ");
  const descendingMetric = key => ["rider_count","team_count","stage_wins","podium_finishes"].includes(key);

  function sortCountries(rows, key, desc) {
    const value = c => key === "best_name" ? bestNames(c) || null : c[key];
    return rows.slice().sort((a,b) => {
      const av = value(a), bv = value(b);
      if (av == null && bv != null) return 1;
      if (bv == null && av != null) return -1;
      const byMetric = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : n(av)-n(bv);
      return (desc ? -byMetric : byMetric) || a.country_name.localeCompare(b.country_name) || a.country_code.localeCompare(b.country_code);
    });
  }

  function countriesMarkup(rows, view, order, state) {
    const cols = [["country_name","Country"],...views[view]];
    const headings = cols.map(([key,label]) => {
      const sorted = order.key === key;
      return `<th scope="col"${sorted ? ` aria-sort="${order.desc ? "descending" : "ascending"}"` : ""}>
        ${button("country-sort",key,`${label}${sorted ? (order.desc ? " ↓" : " ↑") : ""}`,{className:"route-sort",label:`Sort by ${label}`})}</th>`;
    }).join("");
    const body = rows.map(c => {
      const code = c.country_code;
      const cells = views[view].map(([key]) => {
        const metric = key === "best_name" ? "best_gc_rank" : key;
        const value = key === "best_name" ? bestNames(c) || "—" : c[key] ?? "—";
        return `<td>${button("country-cell",code,value,{metric,pressed:state.countryCode===code && state.countryMetric===metric,label:`${c.country_name}, ${labels[metric]}, ${value}`})}</td>`;
      }).join("");
      return `<tr${state.countryCode === code ? ' class="route-selected"' : ""}><th scope="row">${esc(c.country_name)} <small>${esc(code)}</small></th>${cells}</tr>`;
    }).join("");
    const scope = view === "participation" ? "Whole race · riders by nationality, teams by registration." :
      "Rider nationality · final GC uses whole-race adjusted time and overall rank. Stage wins and podium places follow the selected stages.";
    return `<section class="analysis-block"><header class="analysis-head">${head("Countries")}
      <div class="analysis-segment route-modes" role="group" aria-label="Country measures">
      ${[["participation","Participation"],["results","Race results"]].map(([key,label]) => button("country-view",key,label,{className:"route-option",pressed:key===view})).join("")}</div></header>
      ${note(scope)}${rows.length ? `<div class="analysis-table-wrap route-table-scroll" data-scroll="countries" role="region" tabindex="0" aria-label="Country comparison"><table class="analysis-table"><thead><tr>${headings}</tr></thead><tbody>${body}</tbody></table></div>` :
        empty("No participating countries match the current rider and team filters.")}</section>`;
  }

  function countryMembersMarkup(rows, role, activeTeam) {
    if (role === "registration" && !activeTeam) {
      const teams = new Map();
      for (const r of rows) {
        const key = n(r.team_key);
        const team = teams.get(key) || {key, name:r.team_name, count:0};
        team.count++;
        teams.set(key,team);
      }
      const items = [...teams.values()].sort((a,b) => a.name.localeCompare(b.name)).map(t =>
        `<tr><td>${button("registered-team",t.key,t.name,{label:`View ${t.name} roster`})}</td><td>${esc(t.count)}</td></tr>`);
      return items.length ? table(["Registered team","Matching riders"],items,"country-members","Teams by registration") : empty("No registered teams match the current filters.");
    }
    const members = activeTeam ? rows.filter(r => n(r.team_key) === activeTeam) : rows;
    const lines = members.map(r => `<tr><td>${esc(r.bib_number)}</td><td>${button("member-drill",r.rider_key,r.rider_name,{label:`Open evidence for ${r.rider_name}`})}</td>
      <td>${esc(r.team_name)}</td><td>${esc(r.rider_country_name)}</td><td>${esc(r.participation_status ?? "—")}</td></tr>`);
    const rosterHead = activeTeam && members.length ? `<div class="analysis-head"><h4>${esc(members[0].team_name)}</h4>${button("all-registered","","All registered teams")}</div>` : "";
    return rosterHead + (lines.length ? table(["Bib","Rider","Team","Rider nationality","Race status"],lines,"country-members","Country roster evidence") : empty("No matching riders for this country role."));
  }

  function countryEvidence(c, metric, rosterRows, activeTeam, loading, error) {
    const roster = metric === "rider_count" || metric === "team_count";
    const role = metric === "team_count" ? "registration" : "nationality";
    const title = `<h3 class="analysis-title" tabindex="-1" data-evidence-heading>${esc(c.country_name)} · ${labels[metric]}</h3>`;
    const subtitle = `${role === "registration" ? "Team registration" : "Rider nationality"} · ${roster || metric === "best_gc_rank" ? "Whole race" : "Selected stages"}`;
    const access = metric !== "best_gc_rank" && n(c[metric]) > 0 ? button("country-drill","","Explore in Drill Down") : "";
    let html;
    if (roster) {
      if (loading) html = '<p class="analysis-note" role="status">Loading roster…</p>';
      else if (error) html = empty(error) + button("retry-country","","Retry roster");
      else {
        const filtered = rosterRows.filter(r => role === "registration" ? r.is_team_registered : r.is_rider_national);
        html = countryMembersMarkup(filtered,role,activeTeam);
      }
    } else if (metric === "best_gc_rank") {
      const lines = (c.best_gc_riders || []).map(r => `<tr><td>${esc(r.gc_rank)}</td><td>${esc(r.bib_number)}</td>
        <td>${button("final-rider",r.rider_key,r.rider_name,{label:`${r.rider_name}, open final classifications`})}</td><td>${esc(r.team_name)}</td><td class="route-time">${clock(r.total_seconds)}</td></tr>`);
      html = lines.length ? table(["Final GC rank","Bib","Rider","Team","Adjusted time"],lines,"country-gc","Final GC evidence") : empty("No qualifying final GC finishers.");
    } else {
      const records = (c.podium_rows || []).filter(r => metric === "podium_finishes" || n(r.finish_rank) === 1);
      const lines = records.map(r => `<tr><td>${button("medal-stage",r.stage_id,`Stage ${r.stage_id}`,{metric:r.rider_key,label:`Open stage ${r.stage_id}, ${r.rider_name}`})}</td><td>${esc(r.stage_date)}</td>
        <td>${esc(r.rider_name)}</td><td>${esc(r.team_name)}</td><td>${esc(r.finish_rank)}</td><td>${esc(r.participation_status)}</td></tr>`);
      html = lines.length ? table(["Stage","Date","Rider","Team","Source rank","Race status"],lines,"country-medals","Country stage evidence") :
        empty(metric === "stage_wins" ? "No stage wins in this selection." : "No podium places in this selection.");
    }
    return `<section class="analysis-block"><header class="analysis-head"><div>${title}${note(subtitle)}</div>${access}</header>${html}</section>`;
  }

  async function countryPage(ctx) {
    const countries = await ctx.report("country_outcomes");
    if (!ctx.isCurrent()) return;
    const root = mount(ctx), state = ctx.preferences, memberCache = new Map();
    let view = state.countryView === "results" ? "results" : "participation";
    let metric = views[view].some(([k]) => k === state.countryMetric && k !== "best_name") ? state.countryMetric : views[view][0][0];
    let country = countries.find(c => c.country_code === state.countryCode);
    let seq = 0, loading = false, error = "";
    state.countryMetric = metric;
    state.countryOrders = state.countryOrders || {};
    const order = () => state.countryOrders[view] || {key:views[view][0][0],desc:descendingMetric(views[view][0][0])};
    const role = () => metric === "team_count" ? "registration" : "nationality";

    function draw() {
      const ordering = order();
      const rows = sortCountries(countries,ordering.key,ordering.desc);
      const evidence = country ? countryEvidence(country,metric,memberCache.get(country.country_code) || [],n(state.countryTeamKey),loading,error) : "";
      paint(root,countriesMarkup(rows,view,ordering,state) + evidence);
    }
    async function showEvidence(moveFocus = false) {
      const request = ++seq;
      error = "";
      loading = false;
      if (country && view === "participation" && n(country[metric]) > 0 && !memberCache.has(country.country_code)) {
        const code = country.country_code;
        loading = true;
        draw();
        try {
          const payload = await ctx.post(`/api/country/${encodeURIComponent(code)}/members`,ctx.filters);
          if (!ctx.isCurrent() || seq !== request) return;
          memberCache.set(code,payload.rows || []);
        } catch (err) {
          if (!ctx.isCurrent() || seq !== request) return;
          error = err?.message || "The roster could not be loaded.";
        }
        loading = false;
      }
      if (country && metric === "team_count" && state.countryTeamKey) {
        const members = memberCache.get(country.country_code) || [];
        if (!members.some(r => r.is_team_registered && n(r.team_key) === n(state.countryTeamKey))) state.countryTeamKey = null;
      }
      draw();
      if (moveFocus) focusEvidence(root);
    }

    root.onclick = async event => {
      const b = event.target.closest("button[data-action]");
      if (!b || !ctx.isCurrent()) return;
      const {action,value} = b.dataset;
      if (action === "country-sort") {
        const current = order();
        state.countryOrders[view] = {key:value,desc:current.key === value ? !current.desc : descendingMetric(value)};
        draw();
        const box = root.querySelector('[data-scroll="countries"]');
        if (box) box.scrollTop = 0;
        return;
      }
      if (action === "country-view") {
        if (view === value) return;
        view = state.countryView = value;
        metric = state.countryMetric = views[view][0][0];
        state.countryTeamKey = null;
        return showEvidence();
      }
      if (action === "country-cell") {
        country = countries.find(c => c.country_code === value);
        if (!country) return;
        state.countryCode = value;
        metric = state.countryMetric = b.dataset.metric;
        state.countryTeamKey = null;
        return showEvidence(true);
      }
      if (action === "registered-team" || action === "all-registered") {
        state.countryTeamKey = action === "registered-team" ? n(value) : null;
        draw();
        focusEvidence(root);
        return;
      }
      if (action === "retry-country") return showEvidence();
      if (action === "final-rider") return ctx.go("rider_standings",{riderKey:n(value),finalGC:true});
      if (action === "medal-stage") return ctx.go("stage_summary",{stageMode:"order",stageId:n(value),stageRiderKey:n(b.dataset.metric),stageTeamKey:null,stageFull:false});
      if (action === "country-drill" || action === "member-drill") {
        const path = [country.country_code];
        if (role() === "registration" && state.countryTeamKey) path.push(n(state.countryTeamKey));
        if (action === "member-drill") path.push(n(value));
        return ctx.drill({
          dimension:"country",role:role(),path,
          metric:metric === "stage_wins" ? "wins" : metric === "podium_finishes" ? "podiums" : metric === "team_count" && action === "country-drill" && !state.countryTeamKey ? "teams" : "roster",
          label:`${country.country_name} · ${labels[metric]}`,
        });
      }
    };
    await showEvidence();
  }

  window.RacePages = window.RacePages || {};
  window.RacePages.stage_summary = stagesPage;
  window.RacePages.country_participation = countryPage;
})();

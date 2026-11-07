(() => {

  'use strict';

  const pages = window.RacePages ||= {};
  const colors = ['#175c7b', '#a14a14', '#007967', '#82468d', '#505caa'];
  const esc = value => String(value ?? '—').replace(/[&<>"']/g, ch =>
    ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
  const signed = n => n == null ? '—' : n > 0 ? `+${n}` : String(n);
  const position = n => n == null ? '—' : `#${n}`;
  const gap = n => n == null ? '—' : `+${n} s`;
  function clockTime(n) {
    if (n == null) return '—';
    const pad = v => String(v).padStart(2, '0');
    return `${Math.floor(n / 3600)}:${pad(Math.floor(n / 60) % 60)}:${pad(n % 60)}`;
  }
  const block = (title, content, note = '') =>
    `<section class="analysis-block"><div class="analysis-head"><h3>${esc(title)}</h3>${note ? `<span class="analysis-note">${esc(note)}</span>` : ''}</div>${content}</section>`;
  const note = t => `<p class="analysis-note">${esc(t)}</p>`;
  const empty = t => `<p class="analysis-empty">${esc(t)}</p>`;
  const action = (label, name, value = '', selected = false) =>
    `<button type="button" class="analysis-link${selected ? ' gc-picked' : ''}" data-gc-action="${esc(name)}" data-value="${esc(value)}">${esc(label)}</button>`;
  const opt = (value, label, selected) =>
    `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`;
  const select = (id, label, choices, current) =>
    `<label class="gc-control">${esc(label)}<select id="${id}">${choices.map(([v,l]) => opt(v,l,current)).join('')}</select></label>`;
  const table = (headers, rows) => `<div class="analysis-table-wrap"><table class="analysis-table"><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const tr = (cells, selected = false) => `<tr${selected ? ' class="gc-selected-row"' : ''}>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`;
  const method = (summary, content) => `<details class="gc-method"><summary>${esc(summary)}</summary>${content}</details>`;
  const kpis = items => `<div class="analysis-kpis">${items.map(([label, value]) =>
    `<div class="analysis-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')}</div>`;
  function scopeLabel(f) {
    if (f.stage_scope === 'as_of') return `Through stage ${f.as_of_stage || 21}`;
    return f.stage_scope === 'selection' ? 'Selected-stage performance' : 'Full race';
  }
  const poolLabel = f => f.rank_scope === 'filtered' ? 'Filtered group ranks' : 'Full-field ranks';
  const basisLabel = f => f.time_basis === 'finish' ? 'raw time' : 'adjusted time';
  const unique = values => [...new Set(values)];
  const boundedRiders = f => Array.isArray(f.rider_keys) || Array.isArray(f.team_keys) || f.young_only;
  function page(ctx) {
    const root = ctx.element;
    let rendering = false;
    function render(html) {
      if (rendering || !ctx.isCurrent()) return;
      const active = root.ownerDocument?.activeElement;
      const focused = active && root.contains(active) ? active : null;
      rendering = true;
      try {
        root.innerHTML = `<div class="analysis-page gc-page">${html}</div>`;
        if (!focused) return;
        const {gcAction, value} = focused.dataset;
        const selector = focused.id ? `#${focused.id}` : gcAction ?
          `[data-gc-action="${gcAction}"][data-value="${value}"]` : null;
        if (selector) root.querySelector(selector)?.focus?.({preventScroll:true});
      } finally {
        rendering = false;
      }
    }
    function bind(click, change = () => {}, input = () => {}) {
      if (!ctx.isCurrent()) return;
      root.onclick = e => {
        const button = e.target.closest('[data-gc-action]');
        if (ctx.isCurrent() && button && root.contains(button)) return click(button.dataset.gcAction, button.dataset.value);
      };
      root.onchange = e => { if (!rendering && ctx.isCurrent()) return change(e.target); };
      root.oninput = e => { if (!rendering && ctx.isCurrent()) return input(e.target); };
      root.onkeydown = e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('svg [role=button]')) {
          e.preventDefault();
          if (ctx.isCurrent()) return click(e.target.dataset.gcAction, e.target.dataset.value);
        }
      };
    }
    return {render, bind};
  }

  // Shared stage axis keeps cumulative lines and daily separation vertically aligned.
  function chart(series, stages, field, active, {rank = false, daily = null, marks = []} = {}) {
    if (!series.length || !stages.length) return empty('No stages in this scope.');
    const w = 920, left = 68, right = 28, top = 18, bottom = 164, axis = 184;
    const orders = stages.map(s => s.stage_order);
    const first = Math.min(...orders), last = Math.max(...orders);
    const step = (w - left - right) / Math.max(1, last - first + 1);
    const x = order => left + (order - first + 0.5) * step;
    const values = series.flatMap(s => s.rows.map(r => r[field]));
    const min = rank ? 1 : 0;
    const max = Math.max(min + 1, ...values);
    const y = value => rank
      ? top + (bottom-top)*(value-min)/(max-min)
      : bottom - (bottom-top)*(value-min)/(max-min);
    const tick = v => rank ? position(v) : field === 'cumulative_seconds' ? clockTime(v) : `${v} s`;
    const ticks = unique([min, Math.round((min+max)/2), max]);
    const tags = stages.map(s => {
      const cx = x(s.stage_order);
      const label = `Stage ${s.stage_id} · ${s.stage_type}`;
      const highlight = s.stage_id === active ? `<line x1="${cx}" x2="${cx}" y1="${top}" y2="${bottom}" stroke="#58718a" stroke-dasharray="3 3"/>` : '';
      return `${s.stage_type === 'mountain' ? `<rect x="${cx-step/2}" y="${top}" width="${step}" height="${bottom-top}" fill="#e6f2ec"/>` : ''}${highlight}<text x="${cx}" y="${axis}" text-anchor="middle">S${esc(s.stage_id)}</text><rect data-gc-action="stage" data-value="${esc(s.stage_id)}" role="button" tabindex="0" aria-label="${esc(label)}" x="${cx-step/2}" y="${top}" width="${step}" height="${axis-top+4}" fill="transparent"><title>${esc(label)}</title></rect>`;
    });
    const grid = ticks.map(t => `<line x1="${left}" x2="${w-right}" y1="${y(t)}" y2="${y(t)}" stroke="#d2dbe2"/><text x="${left-6}" y="${y(t)+4}" text-anchor="end">${tick(t)}</text>`).join('');
    const lines = series.map(({rows,color,focused}) => {
      const points = rows.map(r => `${x(r.stage_order)},${y(r[field])}`).join(' ');
      return `<g pointer-events="none"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="${focused ? 3.4 : 1.9}"/>${rows.map(r =>
        `<circle cx="${x(r.stage_order)}" cy="${y(r[field])}" r="${r.stage_id === active || marks.includes(r.stage_id) ? 4.3 : 2.2}" fill="${color}" stroke="white" stroke-width="0.8"/>`).join('')}</g>`;
    });
    const markFlags = marks.map(id => stages.find(s => s.stage_id === id)).filter(Boolean).map(s =>
      `<path d="M${x(s.stage_order)-4} 5h8l-4 7z" fill="#8a461d" pointer-events="none"/>`).join('');
    let bars = '';
    if (daily) {
      const base = 282, highest = Math.max(1, ...daily.map(d => d.value ?? 0));
      bars = `<text x="${left}" y="214">Daily separation (s)</text><line x1="${left}" x2="${w-right}" y1="${base}" y2="${base}" stroke="#b8c6cf"/>` +
        daily.map(d => {
          const cx = x(d.stage.stage_order), barWidth = Math.min(21, step*0.58);
          const height = d.value == null ? 0 : Math.max(2, d.value/highest*49);
          const text = d.value == null ? '—' : String(d.value);
          return `<g role="button" tabindex="0" aria-label="Stage ${d.stage.stage_id}, separation ${esc(text)} seconds" data-gc-action="stage" data-value="${d.stage.stage_id}"><rect x="${cx-step/2}" y="220" width="${step}" height="66" fill="transparent"/><rect x="${cx-barWidth/2}" y="${base-height}" width="${barWidth}" height="${height}" rx="2" fill="${d.stage.stage_id === active ? '#9c5608' : '#217778'}"/><text x="${cx}" y="${base-height-4}" text-anchor="middle">${esc(text)}</text></g>`;
        }).join('');
    }
    return `<div class="gc-chart"><svg viewBox="0 0 ${w} ${daily ? 292 : 194}" role="group" aria-label="${rank ? 'Cumulative rank by stage' : 'Cumulative time and daily separation by stage'}">${tags.join('')}<g pointer-events="none">${grid}</g>${lines.join('')}${markFlags}${bars}</svg></div>`;
  }

  function stageLink(ctx, row, filters) {
    ctx.drill({
      dimension: 'team', path: [row.team_key, row.rider_key], metric: 'results',
      ...(filters !== ctx.filters ? {baseFilters:filters} : {}),
      filters: {...filters, stage_scope:'selection', stage_ids:[row.stage_id], rider_keys:[row.rider_key]},
      label: `${row.rider_name} · stage ${row.stage_id}`
    });
  }
  function factTable(rows, options = {}) {
    return table(['Stage','Date','Stage Type','Finish','Raw Time','Bonus','Penalty','Adjusted Time'], rows.map(r =>
      tr([action(`S${r.stage_id}`,'fact',r.stage_id), esc(r.stage_date), esc(r.stage_type),
        esc(position(r.finish_rank)), clockTime(r.finish_time_seconds), `${r.time_bonus_seconds} s`,
        `${r.time_penalty_seconds} s`, clockTime(r.adjusted_time_seconds)], r.stage_id === options.selected)));
  }



  const sortOptions = [
    ['gc','GC rank'], ['mountain','Mountain rank'], ['gain','Largest mountain rank gain'],
    ['loss','Largest mountain rank loss'], ['young','Youth rank'], ['name','Rider name']
  ];
  function compareStandings(rows, p) {
    const search = (p.search || '').trim().toLocaleLowerCase();
    const list = rows.filter(r => (!p.age || r.age_group === p.age) &&
      (!search || `${r.rider_name} ${r.bib_number} ${r.team_name}`.toLocaleLowerCase().includes(search)));
    const score = r => {
      if (p.sort === 'gain') return r.mountain_rank_gain == null ? Infinity : -r.mountain_rank_gain;
      if (p.sort === 'loss') return r.mountain_rank_gain ?? Infinity;
      if (p.sort === 'young') return r.young_gc_rank ?? Infinity;
      if (p.sort === 'mountain') return r.mountain_gc_rank ?? Infinity;
      return r.gc_rank;
    };
    return list.sort((a,b) => (p.sort === 'name' ? a.rider_name.localeCompare(b.rider_name) : score(a)-score(b)) ||
      a.gc_rank-b.gc_rank || a.rider_key-b.rider_key);
  }
  function readingScope(ctx) {
    const p = ctx.preferences, signature = JSON.stringify(ctx.filters);
    // Deep links identify a particular classification even when the source page shows a single day.
    if (p.finalGC || p.asOfStage) {
      p.age = ''; p.search = '';
      const filters = p.finalGC ? {stage_scope:'final',rank_scope:'overall',time_basis:'adjusted'} :
        {...ctx.filters,stage_scope:'as_of',as_of_stage:p.asOfStage};
      if (!p.finalGC && p.plottedRiderKeys) filters.rider_keys = p.plottedRiderKeys.slice();
      delete filters.stage_ids;
      delete filters.stage_types;
      p.classScope = {signature,filters};
      delete p.plottedRiderKeys;
      delete p.finalGC;
      delete p.asOfStage;
    }
    if (p.classScope?.signature !== signature) delete p.classScope;
    return p.classScope?.filters ?? ctx.filters;
  }
  function proxyMethod(mode) {
    const points = mode === 'points_proxy';
    return method('Proxy scoring', note(points ?
      'Stage finish positions 1–15 score. Flat stages award 50, 30, 20, 18, 16, 14, 12, 10, 8, 7, 6, 5, 4, 3, 2. Hilly stages award 30, 25, 22, 19, 17, 15, 13, 11, 9, 7, 6, 5, 4, 3, 2. Mountain stages and time trials award 20, 17, 15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1.' :
      'Mountain stage finish positions 1–10 earn 20, 15, 12, 10, 8, 6, 4, 3, 2, 1. Hilly stage positions 1–5 earn 10, 6, 4, 2, 1. Flat stages and time trials earn zero.') +
      note('Other places score zero. These derived points use stage finishes only. Intermediate sprints and individual climb awards are unavailable.'));
  }
  pages.rider_standings = async function classifications(ctx) {
    const ui = page(ctx), p = ctx.preferences, f = readingScope(ctx);
    const rows = await ctx.report('gc_comparison', f);
    if (!ctx.isCurrent()) return;
    let track = [], proxy = [], trackLoading = false, proxyLoading = false, error = '', ticket = 0, proxyTicket = 0;
    let cohortHistory;
    let rider = rows.find(r => r.rider_key === p.riderKey) || rows[0];
    if (rider) p.riderKey = rider.rider_key;
    if (['points_proxy','kom_proxy'].includes(p.classification)) {
      p.proxy = p.classification;
      delete p.classification;
    }
    if (!p.proxy && ['points_proxy','kom_proxy'].includes(f.classification)) p.proxy = f.classification;
    function draw() {
      if (!rows.length) return ui.render(empty('No eligible riders in this scope.'));
      const matches = compareStandings(rows, p);
      const shown = p.showAll || p.search ? matches : matches.slice(0,10);
      if (matches.includes(rider) && !shown.includes(rider)) shown.push(rider);
      const filters = `<div class="analysis-toolbar"><label class="gc-control">Find a rider or team<input type="search" id="gc-find" value="${esc(p.search || '')}" placeholder="Name, team or bib"></label>${select('gc-age','Age on race day',[['','All ages'],...['U23','23-25','26-29','30+'].map(v=>[v,v])],p.age || '')}${select('gc-sort','Order',sortOptions,p.sort || 'gc')}</div>`;
      const rankTable = table(['GC','Bib','Rider','Team','Age','Youth','Mountain','Mountain gain','Time','Gap'], shown.map(r =>
        tr([position(r.gc_rank),esc(r.bib_number),action(r.rider_name,'rider',r.rider_key),esc(r.team_name),esc(r.age_at_race),
          position(r.young_gc_rank),position(r.mountain_gc_rank),signed(r.mountain_rank_gain),clockTime(r.total_seconds),gap(r.gap_seconds)],r === rider)));
      const button = matches.length > 10 && !p.search ? action(p.showAll ? 'Show first 10' : `Show all ${matches.length} riders`,'all') : '';
      const contextButton = p.classScope ? action('Use current dashboard filters','releaseScope') : '';
      const rankResults = (shown.length ? rankTable : empty('No riders match your search and age group.')) +
        `<div class="gc-table-foot">${p.search || p.age ? `<span>${matches.length} ${matches.length === 1 ? 'match' : 'matches'}</span>` : ''}${button}${contextButton}</div>` +
        method('Classification rules',note('GC orders riders who completed every stage in the scope by cumulative time. Youth ranks use riders born on or after 1 January 2000. Mountain ranks use the same completion requirement and only mountain-stage time. Age is measured on 5 July 2025. Search and age choices preserve ranks.'));
      let panels = '';
      if (matches.includes(rider)) {
        panels += trajectoryBlock();
      }
      const proxyControls = select('gc-proxy','More classifications',[
        ['','Choose a points table'],['points_proxy','Points Proxy'],['kom_proxy','KOM Points Proxy']
      ],p.proxy || '');
      let extra = '';
      if (p.proxy) {
        const visible = p.proxyAll ? proxy : proxy.slice(0,10);
        extra = proxyLoading ? note('Loading points…') : !visible.length ? empty('No eligible riders for this points table.') :
          table(['Rank','Bib','Rider','Team','Points'],visible.map(r => tr([position(r.rank),esc(r.bib_number),action(r.rider_name,'rider',r.rider_key),esc(r.team_name),esc(r.points)]))) +
          (proxy.length > 10 ? action(p.proxyAll ? 'Show first 10' : `Show all ${proxy.length} riders`,'proxyAll') : '');
        extra += proxyMethod(p.proxy);
      }
      panels += block('Points Classifications',`<div class="analysis-toolbar">${proxyControls}</div>${extra}`);
      // Keep the editing node mounted for native caret, focus and IME handling.
      const root = ctx.element;
      const resultsNode = root.querySelector('[data-gc-rank-results]');
      const panelsNode = root.querySelector('[data-gc-panels]');
      if (root.ownerDocument?.activeElement?.id === 'gc-find' && resultsNode && panelsNode) {
        resultsNode.innerHTML = rankResults;
        panelsNode.innerHTML = panels;
        return;
      }
      ui.render(block('Compare Classifications',filters + `<div data-gc-rank-results>${rankResults}</div>`,
        `${scopeLabel(f)} · ${poolLabel(f)} · ${basisLabel(f)}`) + `<div class="gc-panels" data-gc-panels>${panels}</div>`);
    }
    function trajectoryBlock() {
      const title = `${rider.rider_name} · personal GC turning point`;
      const riderContext = [rider.team_name, `${rider.mountain_stage_count} mountain stages`];
      if (rider.mountain_seconds != null) riderContext.push(`Mountain time ${clockTime(rider.mountain_seconds)}`);
      const subtitle = riderContext.join(' · ');
      if (trackLoading) return block(title,note('Loading stage history…'),subtitle);
      if (error || !track.length) return block(title,empty(error || 'No stage results for this rider.'),subtitle);
      const changes = track.filter(r => r.rank_gain != null);
      const largest = Math.max(0,...changes.map(r => Math.abs(r.rank_gain)));
      const turning = largest ? changes.filter(r => Math.abs(r.rank_gain) === largest) : [];
      const active = track.find(r => r.stage_id === p.stageId) || turning[0] || track[0];
      p.stageId = active.stage_id;
      const ties = turning.length > 1 ? `<div class="gc-inline">Tied stages ${turning.map(r=>action(`S${r.stage_id}`,'stage',r.stage_id)).join(' ')}</div>` : '';
      const scope = changes.length ? largest ? `Largest change · ${largest} places` : 'Rank held across these stages' : 'No preceding stage';
      const selected = `<div class="analysis-toolbar">${select('gc-personal-stage','Inspect stage',track.map(r=>[r.stage_id,`S${r.stage_id} · ${r.stage_date}`]),active.stage_id)}
        ${action('Compare with other riders','evolution')}</div>`;
      return block(title, chart([{rows:track,color:colors[0],focused:true}],track,'cumulative_rank',active.stage_id,{rank:true,marks:turning.map(r=>r.stage_id)}) +
        ties + selected + kpis([['Previous rank',position(active.previous_rank)],['Stage-end rank',position(active.cumulative_rank)],['Places gained',signed(active.rank_gain)]]) +
        factTable([active],{selected:active.stage_id}),`${subtitle} · ${scope}`);
    }
    async function loadTrack() {
      const id = ++ticket;
      trackLoading = true; track = []; error = ''; draw();
      if (!rider) return;
      try {
        let history;
        if (f.rank_scope === 'filtered') {
          // All focus riders share this page's ranking cohort, including in-flight reads.
          cohortHistory ??= ctx.report('gc_trajectory',{
            ...f, rider_keys: f.rider_keys ?? ctx.metadata.riders.map(r=>r.rider_key)
          }).then(groupedTrajectory).catch(err => { cohortHistory = undefined; throw err; });
          history = (await cohortHistory).get(rider.rider_key) || [];
        } else {
          const rows = await ctx.report('gc_trajectory',{...f,rider_keys:[rider.rider_key]});
          history = groupedTrajectory(rows).get(rider.rider_key) || [];
        }
        if (id !== ticket || !ctx.isCurrent()) return;
        track = history;
      } catch (err) {
        if (id !== ticket || !ctx.isCurrent()) return;
        error = 'Stage history could not be loaded.';
      }
      trackLoading = false; draw();
    }
    async function loadProxy() {
      const id = ++proxyTicket; proxy = []; proxyLoading = !!p.proxy; draw();
      if (!p.proxy) return;
      try {
        const result = await ctx.analytics('rider_standings',{...f,classification:p.proxy});
        if (id !== proxyTicket || !ctx.isCurrent()) return;
        proxy = result;
      } catch (err) {
        if (id !== proxyTicket || !ctx.isCurrent()) return;
        proxyLoading = false;
        ui.render(empty('Points could not be loaded. Refresh to retry.')); return;
      }
      proxyLoading = false; draw();
    }
    function refreshSearch(el) {
      if (el.id === 'gc-find') { p.search = el.value; draw(); }
    }
    ui.bind((name,v) => {
      if (name === 'releaseScope') { delete p.classScope; return ctx.go('rider_standings',{}); }
      if (name === 'rider') {
        const chosen = rows.find(r=>r.rider_key === Number(v));
        if (!chosen) return;
        rider = chosen; p.riderKey = chosen.rider_key; delete p.stageId;
        if (!compareStandings(rows,p).includes(chosen)) {p.search = ''; p.age = '';}
        return loadTrack();
      }
      if (name === 'all') p.showAll = !p.showAll;
      if (name === 'proxyAll') p.proxyAll = !p.proxyAll;
      if (name === 'stage') p.stageId = Number(v);
      if (name === 'fact') { const r = track.find(row=>row.stage_id===Number(v)); if (r) stageLink(ctx,r,f); return; }
      if (name === 'evolution') return ctx.go('gc_evolution',{riderKey:rider.rider_key,stageId:p.stageId});
      draw();
    }, el => {
      if (el.id === 'gc-find') return;
      if (el.id === 'gc-personal-stage') p.stageId = Number(el.value);
      if (el.id === 'gc-age') p.age = el.value;
      if (el.id === 'gc-sort') p.sort = el.value;
      if (el.id === 'gc-proxy') { p.proxy = el.value; p.proxyAll = false; return loadProxy(); }
      draw();
    },refreshSearch);
    if (!rider) return draw();
    await Promise.all([loadTrack(), ...(p.proxy ? [loadProxy()] : [])]);
  };


  function visibleStages(stages, f) {
    return stages.filter(s => {
      if (f.stage_scope === 'as_of') return s.stage_order <= (f.as_of_stage || 21);
      if (f.stage_scope !== 'selection') return true;
      return (!f.stage_ids || f.stage_ids.includes(s.stage_id)) && (!f.stage_types || f.stage_types.includes(s.stage_type));
    }).sort((a,b)=>a.stage_order-b.stage_order);
  }
  function groupedTrajectory(rows) {
    const byRider = new Map();
    for (const row of rows) {
      if (!byRider.has(row.rider_key)) byRider.set(row.rider_key,[]);
      byRider.get(row.rider_key).push(row);
    }
    for (const list of byRider.values()) list.sort((a,b)=>a.stage_order-b.stage_order);
    return byRider;
  }
  function groupDays(stages, byRider, keys) {
    return stages.map(stage => {
      const rows = keys.map(key => byRider.get(key)?.find(r => r.stage_id === stage.stage_id)).filter(Boolean);
      const changes = rows.map(r=>r.daily_gap_change);
      const value = rows.length >= 2 && rows.length === keys.length && changes.every(Number.isFinite)
        ? Math.max(...changes) - Math.min(...changes) : null;
      const swaps = [];
      for (let i=0; i<rows.length; i++) {
        const a = rows[i];
        for (const b of rows.slice(i+1)) {
          if (a.previous_rank != null && b.previous_rank != null &&
            (a.previous_rank-b.previous_rank)*(a.cumulative_rank-b.cumulative_rank) < 0) swaps.push([a,b]);
        }
      }
      return {stage,rows,value,swaps};
    });
  }
  pages.gc_evolution = async function evolution(ctx) {
    const p = ctx.preferences, f = ctx.filters, ui = page(ctx);
    const stages = visibleStages(ctx.metadata.stages, f);
    if (!stages.length) return ui.render(empty('No stages in this scope.'));
    let defaultIds = [];
    const bounded = boundedRiders(f);
    if (!bounded) {
      const standings = await ctx.analytics('rider_standings',{stage_scope:'final',classification:'gc',time_basis:'adjusted',rank_scope:'overall'});
      if (!ctx.isCurrent()) return;
      defaultIds = standings.slice().sort((a,b)=>a.total_seconds-b.total_seconds || a.rider_key-b.rider_key).slice(0,5).map(r=>r.rider_key);
    }
    const request = {...f, stage_scope:'final', rank_scope:'overall'};
    if (!bounded) request.rider_keys = unique([...defaultIds, ...(p.riderKey ? [p.riderKey] : [])]);
    if (f.young_only && !f.team_keys && !f.rider_keys) request.rider_keys = ctx.metadata.riders.filter(r=>r.is_young_rider).map(r=>r.rider_key);
    const history = await ctx.report('gc_trajectory',request);
    const allRanks = groupedTrajectory(history);
    const visibleIds = new Set(stages.map(s=>s.stage_id));
    const fullRanks = groupedTrajectory(history.filter(r=>visibleIds.has(r.stage_id)));
    if (!ctx.isCurrent()) return;
    if (!fullRanks.size) return ui.render(empty('No matching riders have eligible stage results.'));
    const recent = [...fullRanks.values()].map(list=>list.at(-1)).sort((a,b)=>
      b.stage_order-a.stage_order || a.cumulative_rank-b.cumulative_rank || a.rider_key-b.rider_key);
    const sortedKeys = bounded ? recent.map(r=>r.rider_key) : defaultIds.filter(key=>fullRanks.has(key));
    const signature = JSON.stringify([f.team_keys,f.rider_keys,!!f.young_only,f.time_basis]);
    const held = p.groupSignature === signature && p.groupKeys?.includes(p.riderKey) && allRanks.has(p.riderKey);
    let focus = fullRanks.has(p.riderKey) || held ? p.riderKey : sortedKeys[0] ?? recent[0].rider_key;
    let keys = [], byRider = fullRanks, days = [], ticket = 0;
    const nameOf = key => allRanks.get(key)[0].rider_name;
    const reference = f.rank_scope === 'filtered' ? 'Plotted group' : 'Full field';
    function relevantSwaps(d) {
      return p.allSwaps ? d.swaps : d.swaps.filter(pair=>pair.some(r=>r.rider_key === focus));
    }
    function draw() {
      const comparable = days.filter(d=>d.value != null);
      const largest = comparable.reduce((best,d)=>!best || d.value > best.value ? d : best,null);
      const active = days.find(d=>d.stage.stage_id === p.stageId) || largest || days.find(d=>d.rows.length) || days[0];
      if (!active) return ui.render(empty('No stages in this scope.'));
      p.stageId = active.stage.stage_id;
      const series = keys.map((k,i)=>({rows:byRider.get(k) || [],color:colors[i],focused:k===focus}));
      const field = p.chartMode === 'gap' ? 'cumulative_gap_seconds' : 'cumulative_seconds';
      const marks = days.filter(d=>relevantSwaps(d).length).map(d=>d.stage.stage_id);
      const legend = `<div class="gc-legend">${keys.map((k,i)=>`<span><i style="background:${colors[i]}"></i>${esc(nameOf(k))}${k === focus ? ' · focus' : ''}</span>`).join('')}<span><i class="gc-mountain"></i>Mountain stage</span></div>`;
      const actualTop5 = defaultIds.length && keys.length === defaultIds.length && keys.every(k=>defaultIds.includes(k));
      const cohort = actualTop5 ? 'Final GC top 5' : bounded ? 'Matching riders' : 'Focus rider and final GC contenders';
      const focusOptions = unique([...recent.map(r=>r.rider_key),...keys]).map(key => [key, nameOf(key)]);
      const controls = `<div class="analysis-toolbar">${select('gc-focus','Focus rider',focusOptions,focus)}
        ${select('gc-metric','Time measure',[['time','Cumulative time'],['gap','Gap to GC leader']],p.chartMode || 'time')}
        <label class="gc-check"><input type="checkbox" id="gc-all-swaps" ${p.allSwaps ? 'checked' : ''}>Show swaps for all riders</label></div>`;
      const annotations = marks.length ? `<div class="gc-inline">Rank swaps ${days.filter(d=>relevantSwaps(d).length)
        .map(d=>action(`S${d.stage.stage_id} (${relevantSwaps(d).length})`,'stage',d.stage.stage_id,d===active)).join('')}</div>` :
        note(p.allSwaps ? 'No rank swaps among these riders.' : 'No rank swaps involving the focus rider.');
      let html = block('How Did the GC Race Unfold?',controls + legend +
        chart(series,stages,field,active.stage.stage_id,{daily:days,marks}) + annotations +
        method('Time, gaps and daily separation',note(`Cumulative ${basisLabel(f)} runs from the start through each day. Gaps and ranks use the ${reference.toLowerCase()} leader. A swap requires a reversal from the preceding race day. Triangles mark swap days.`) +
          note('Separation is the largest minus the smallest daily change in GC gap. Day one starts from zero. A dash means that fewer than two riders were plotted or the group lacked a result.')),
        `${cohort} · Ranks against ${reference.toLowerCase()}`);
      const stage = active.stage;
      const stageControls = `<div class="analysis-toolbar">${select('gc-day','Inspect stage',stages.map(s=>[s.stage_id,`S${s.stage_id} · ${s.stage_date}`]),stage.stage_id)}${action('Open stage results','route',stage.stage_id)}</div>`;
      const swaps = relevantSwaps(active).map(([a,b])=>`<li>${esc(a.rider_name)} ${position(a.previous_rank)} → ${position(a.cumulative_rank)} · ${esc(b.rider_name)} ${position(b.previous_rank)} → ${position(b.cumulative_rank)}</li>`).join('');
      const selectedRows = active.rows.map(r => tr([
        action(r.rider_name,'personal',r.rider_key), position(r.cumulative_rank), clockTime(r.stage_seconds),
        clockTime(r.cumulative_seconds),gap(r.cumulative_gap_seconds),`${signed(r.daily_gap_change)} s`,
        `${r.time_bonus_seconds} s`,`${r.time_penalty_seconds} s`,action('Result','fact',r.rider_key)
      ],r.rider_key === focus));
      html += block(`Stage ${stage.stage_id} · ${stage.start_location_name || ''} → ${stage.finish_location_name || ''}`,
        stageControls + (swaps ? `<ul class="gc-swaps">${swaps}</ul>` : '') + (selectedRows.length ?
          table(['Personal trajectory','GC rank','Stage time','Cumulative','GC gap','Gap change','Bonus','Penalty','Evidence'],selectedRows) :
          empty('No plotted riders recorded a result on this stage.')),
        `${stage.stage_date} · ${stage.stage_type} · separation ${active.value == null ? '—' : `${active.value} s`}`);
      ui.render(html);
    }
    async function chooseGroup(keepPrevious) {
      const id = ++ticket;
      const prior = keepPrevious && p.groupSignature === signature ? (p.groupKeys || []).filter(k=>allRanks.has(k)) : [];
      const preferred = prior.length ? [...prior, ...sortedKeys] : sortedKeys;
      keys = unique([focus,...preferred]).slice(0,5);
      p.riderKey = focus; p.groupKeys = keys.slice(); p.groupSignature = signature;
      if (f.rank_scope === 'filtered') {
        ui.render(note('Calculating ranks within the plotted group…'));
        const data = await ctx.report('gc_trajectory',{...f,rider_keys:keys,rank_scope:'filtered'});
        if (id !== ticket || !ctx.isCurrent()) return;
        byRider = groupedTrajectory(data);
      }
      days = groupDays(stages,byRider,keys);
      draw();
    }
    ui.bind((name,v)=>{
      if (name === 'stage') { p.stageId = Number(v); draw(); }
      if (name === 'route') return ctx.go('stage_summary',{stageId:Number(v),stageMode:'order',stageTeamKey:null,stageRiderKey:null,stageFull:false});
      if (name === 'personal') return ctx.go('rider_standings',{
        riderKey:Number(v),asOfStage:p.stageId,stageId:p.stageId,
        plottedRiderKeys:f.rank_scope === 'filtered' ? keys.slice() : null
      });
      if (name === 'fact') {
        const r = byRider.get(Number(v))?.find(r=>r.stage_id === p.stageId);
        if (r) stageLink(ctx,r,f);
      }
    },el=>{
      if (el.id === 'gc-focus') {
        focus = Number(el.value); delete p.stageId;
        return chooseGroup(false);
      }
      if (el.id === 'gc-metric') p.chartMode = el.value;
      if (el.id === 'gc-all-swaps') p.allSwaps = el.checked;
      if (el.id === 'gc-day') p.stageId = Number(el.value);
      draw();
    });
    await chooseGroup(true);
  };



  function crossingChart(rows, selected) {
    const min = Math.min(10, ...rows.flatMap(r=>[r.baseline_rank,r.scenario_rank]));
    const max = Math.max(11, ...rows.flatMap(r=>[r.baseline_rank,r.scenario_rank]));
    const y = n => 32 + (n-min)/(max-min)*95;
    const boundary = y(10.5);
    const ticks = unique([min,10,11,max]).sort((a,b)=>a-b).filter((n,i,a) => !i || y(n)-y(a[i-1]) >= 12);
    return `<svg class="gc-slope" viewBox="0 0 420 145" role="img" aria-label="Crossings between standard and scenario top ten">
      <text x="90" y="14" text-anchor="middle">Standard GC</text><text x="330" y="14" text-anchor="middle">Scenario GC</text>
      <rect x="90" y="24" width="240" height="${boundary-24}" fill="#edf5ed"/>
      <path d="M90 24v109m240 -109v109" fill="none" stroke="#b8c4cf"/>
      <path d="M90 ${boundary}h240" stroke="#62917c" stroke-dasharray="4 3"/>
      ${ticks.map(n=>`<text x="82" y="${y(n)+4}" text-anchor="end">#${n}</text><text x="339" y="${y(n)+4}">#${n}</text>`).join('')}
      ${rows.map(r=>`<path d="M90 ${y(r.baseline_rank)} L330 ${y(r.scenario_rank)}" fill="none" stroke="${r.scenario_rank <= 10 ? '#087766' : '#a45a1e'}" stroke-width="${r.rider_key === selected ? 3.5 : 1.9}"><title>${esc(r.rider_name)} · ${position(r.baseline_rank)} → ${position(r.scenario_rank)}</title></path>`).join('')}
    </svg>`;
  }


  const scenarioNames = {
    standard:'Standard timing', no_bonus:'Bonuses removed', no_penalty:'Penalties removed', raw:'Raw finish time'
  };
  const scenarioFormula = {standard:'T − B + P', no_bonus:'T + P', no_penalty:'T − B', raw:'T'};
  function timeScenario(p) {
    if (p.bonuses !== false) return p.penalties !== false ? 'standard' : 'no_penalty';
    return p.penalties !== false ? 'no_bonus' : 'raw';
  }

  pages.time_rules = async function timeRules(ctx) {
    const ui = page(ctx), p = ctx.preferences, f = ctx.filters;
    const data = await ctx.report('gc_time_rules',f);
    if (!ctx.isCurrent()) return;
    if (!data.length) return ui.render(empty('No eligible riders in this scope.'));
    let evidence = [], evidenceState = 'idle', ticket = 0;
    function draw() {
      const mode = timeScenario(p), rows = data.filter(r=>r.scenario === mode);
      const baseline = data.find(r=>r.scenario === 'standard'), raw = data.find(r=>r.scenario === 'raw');
      const entering = rows.filter(r=>r.baseline_rank > 10 && r.scenario_rank <= 10);
      const leaving = rows.filter(r=>r.baseline_rank <= 10 && r.scenario_rank > 10);
      const show = rows.filter(r=>p.showAll || r.baseline_rank <= 10 || r.scenario_rank <= 10);
      const comparing = mode !== 'standard';
      const sort = !comparing && ['rank_gain','scenario_rank'].includes(p.sort) ? 'baseline_rank' : p.sort || 'baseline_rank';
      show.sort((a,b)=> (sort === 'bonus_seconds' || sort === 'penalty_seconds' || sort === 'rank_gain'
        ? b[sort]-a[sort] : a[sort]-b[sort]) || a.baseline_rank-b.baseline_rank || a.rider_key-b.rider_key);
      const changes = [...entering,...leaving].map(r=>tr([action(r.rider_name,'rider',r.rider_key),
        position(r.baseline_rank),`<span class="gc-cross">→</span> ${position(r.scenario_rank)}`,r.scenario_rank <= 10 ? 'Entered' : 'Left']));
      const controls = `<div class="analysis-toolbar gc-toggles">
        <label class="gc-check"><input id="gc-bonus-on" type="checkbox" ${p.bonuses !== false ? 'checked' : ''}>Include bonuses</label>
        <label class="gc-check"><input id="gc-penalty-on" type="checkbox" ${p.penalties !== false ? 'checked' : ''}>Include penalties</label>
        <strong>${esc(scenarioNames[mode])} · ${scenarioFormula[mode]}</strong></div>`;
      const seconds = v => v == null ? '—' : `${v} s`;
      let html = block('How Do Bonuses and Penalties Affect GC?',controls + kpis([
        ['Standard winning margin',seconds(baseline?.winning_margin)],
        [mode === 'standard' ? 'Raw-time winning margin' : 'Scenario winning margin',seconds(mode === 'standard' ? raw?.winning_margin : rows[0]?.winning_margin)],
        ...(comparing ? [['Top-ten entries / exits',`${entering.length} / ${leaving.length}`]] : [])
      ]) + (changes.length ? crossingChart([...entering,...leaving],p.riderKey) + table(['Rider','Standard GC','Scenario GC','Top ten'],changes) : '') +
        (boundedRiders(f) && f.rank_scope !== 'filtered' ? note('Entries and exits show matching riders. Winning margins use the full field.') : '') +
        method('Timing rules',note('T is total raw finish time, B is total bonus seconds and P is total penalty seconds. Each scenario ranks the same eligible riders. Tied times share a rank. A top-ten place includes every rider ranked tenth.')),
        `${scopeLabel(f)} · ${poolLabel(f)}`);
      const sortControl = select('gc-rules-sort','Order',[
        ['baseline_rank','Standard GC'],...(comparing ? [['scenario_rank','Scenario GC'],['rank_gain','Places gained']] : []),
        ['bonus_seconds','Most bonus seconds'],['penalty_seconds','Most penalty seconds']
      ],sort);
      const columns = ['Rider','Standard GC','Bonus (B)','Penalty (P)',
        ...(comparing ? ['Scenario GC','Places gained','Standard gap','Scenario gap','Standard time','Scenario time'] : ['Gap','Time'])];
      const grid = show.map(r=>tr([action(r.rider_name,'rider',r.rider_key),position(r.baseline_rank),
        action(`${r.bonus_seconds} s`,'bonus',r.rider_key),action(`${r.penalty_seconds} s`,'penalty',r.rider_key),
        ...(comparing ? [position(r.scenario_rank),signed(r.rank_gain),gap(r.baseline_gap),gap(r.scenario_gap),
          clockTime(r.baseline_seconds),clockTime(r.scenario_seconds)] : [gap(r.baseline_gap),clockTime(r.baseline_seconds)])],
        p.riderKey === r.rider_key));
      html += block(comparing ? 'Standard and scenario standings' : 'Standard standings',`<div class="analysis-toolbar">${sortControl}
        ${action(p.showAll ? (comparing ? 'Show top ten and changes' : 'Show top ten') : `Show all ${rows.length} eligible riders`,'all')}</div>` +
        (grid.length ? table(columns,grid) :
          empty('No matching riders are in either top ten. Show all eligible riders to inspect their adjustments.')),
        `${show.length} riders shown`);
      const rider = rows.find(r=>r.rider_key === p.riderKey);
      if (rider) {
        const filter = p.adjustment || 'both';
        const matches = evidence.filter(r => filter === 'bonus' ? r.time_bonus_seconds > 0 :
          filter === 'penalty' ? r.time_penalty_seconds > 0 : r.time_bonus_seconds > 0 || r.time_penalty_seconds > 0);
        const toolbar = select('gc-adjustment','Adjustment days',[['both','Bonuses and penalties'],['bonus','Bonuses only'],['penalty','Penalties only']],filter);
        html += block(`${rider.rider_name} · adjustment days`,`<div class="analysis-toolbar">${toolbar}</div>` +
          (evidenceState === 'loading' ? note('Loading results…') : evidenceState === 'error' ? empty('Stage results could not be loaded.') :
            matches.length ? factTable(matches) : empty('No matching adjustments in this scope.')),
          `${rider.bonus_seconds} s bonus · ${rider.penalty_seconds} s penalty`);
      }
      ui.render(html);
    }
    async function loadEvidence() {
      const id = ++ticket;
      evidence = []; evidenceState = 'loading'; draw();
      const request = {...f,rider_keys:[p.riderKey]};
      if (f.stage_scope !== 'selection') { delete request.stage_ids; delete request.stage_types; }
      try {
        const rows = await ctx.analytics('rider_stage_results',request);
        if (!ctx.isCurrent() || id !== ticket) return;
        evidence = rows.sort((a,b)=>a.stage_order-b.stage_order);
        evidenceState = 'ready';
      } catch (err) {
        if (!ctx.isCurrent() || id !== ticket) return;
        evidenceState = 'error';
      }
      draw();
    }
    ui.bind((name,v)=>{
      if (name === 'all') { p.showAll = !p.showAll; draw(); return; }
      if (name === 'fact') {
        const row = evidence.find(r=>r.stage_id === Number(v));
        if (row) stageLink(ctx,row,f);
        return;
      }
      if (['bonus','penalty','rider'].includes(name)) {
        p.riderKey = Number(v); p.adjustment = name === 'rider' ? 'both' : name;
        return loadEvidence();
      }
    },el=>{
      if (el.id === 'gc-bonus-on') p.bonuses = el.checked;
      if (el.id === 'gc-penalty-on') p.penalties = el.checked;
      if (el.id === 'gc-rules-sort') p.sort = el.value;
      if (el.id === 'gc-adjustment') p.adjustment = el.value;
      draw();
    });
    if (data.some(r=>r.rider_key === p.riderKey)) return loadEvidence();
    draw();
  };


})();

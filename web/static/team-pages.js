(() => {
  'use strict';

  const pages = window.RacePages ||= {};
  const types = ['flat', 'hilly', 'mountain', 'individual time-trial'];
  const terrainLabel = {flat:'Flat', hilly:'Hilly', mountain:'Mountain', 'individual time-trial':'ITT'};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
  const available = value => value != null && Number.isFinite(Number(value));
  const num = (value, digits = 0) => available(value) ? Number(value).toLocaleString('en-GB', {maximumFractionDigits:digits}) : '—';
  const signed = value => available(value) ? (value > 0 ? '+' : '') + num(value) : '—';
  const time = value => {
    if (!available(value)) return '—';
    const n = Math.round(Number(value));
    return [Math.floor(n / 3600), Math.floor(n % 3600 / 60), n % 60].map((v,i) => i ? String(v).padStart(2,'0') : v).join(':');
  };
  const byName = (a,b) => String(a).localeCompare(String(b));
  const byKey = (rows, field, key) => rows.find(r => String(r[field]) === String(key));
  const empty = text => '<p class="analysis-empty">' + esc(text) + '</p>';
  const note = text => '<p class="analysis-note">' + esc(text) + '</p>';
  const heading = (title, controls='') => '<div class="analysis-head"><h3>' + esc(title) + '</h3>' + controls + '</div>';
  const block = (id, body) => '<section class="analysis-block" id="tt-' + id + '">' + body + '</section>';
  const btn = (act,k,content,attrs='',className='analysis-link') =>
    '<button type="button" class="' + className + '" data-act="' + act + '" data-k="' + esc(k) + '" ' + attrs + '>' + content + '</button>';
  const option = (v,name,current) => '<option value="' + esc(v) + '"' + (String(current)===String(v) ? ' selected' : '') + '>' + esc(name) + '</option>';
  const select = (act,label,choices,current) => '<label class="tt-control"><span>' + esc(label) + '</span><select data-act="' +
    act + '">' + choices.map(([v,name]) => option(v,name,current)).join('') + '</select></label>';
  const table = (headers, rows, tall=false) => '<div class="analysis-table-wrap' + (tall?' tt-scroll':'') +
    '"><table class="analysis-table"><thead><tr>' + headers.map(h => '<th scope="col">' + esc(h) + '</th>').join('') +
    '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  const bar = (value,max) => '<span class="tt-mini" aria-hidden="true"><i style="width:' + (100 * value / (max || 1)) + '%"></i></span>';
  const teamChoices = teams => teams.map(t => [t.team_key,t.team_name]);
  function stageScope(ctx, type) {
    const f = ctx.filters;
    return (ctx.metadata.stages || []).filter(s =>
      (f.stage_scope !== 'as_of' || s.stage_order <= (f.as_of_stage ?? 21)) &&
      (f.stage_ids == null || f.stage_ids.includes(s.stage_id)) &&
      (f.stage_types == null || f.stage_types.includes(s.stage_type)) && (!type || type === s.stage_type));
  }
  function terrainFilters(ctx,type) {
    return {stage_scope:'selection', stage_types:[type], stage_ids:stageScope(ctx,type).map(s=>s.stage_id)};
  }
  function bind(ctx,handler) {
    const dispatch = event => {
      if (!ctx.isCurrent()) return;
      const target = event.target.closest('[data-act]');
      if (!target || !ctx.element.contains(target)) return;
      if (event.type === 'click' && target.tagName === 'SELECT') return;
      handler(target.dataset, target.value);
    };
    ctx.element.onclick = dispatch;
    ctx.element.onchange = dispatch;
  }
  function paint(ctx, html) {
    if (!ctx.isCurrent()) return;
    const el = ctx.element, focused = el.ownerDocument?.activeElement;
    const oldFocus = focused && el.contains(focused) ? focused.dataset : null;
    const oldScroll = Array.from(el.querySelectorAll?.('[data-scroll]') || [], n => [n.dataset.scroll,n.scrollTop]);
    el.innerHTML = '<div class="analysis-page tt-page">' + html + '</div>';
    for (const [key,top] of oldScroll) {
      const list = el.querySelector('[data-scroll="' + key + '"]');
      if (list) list.scrollTop = top;
    }
    if (oldFocus?.act) {
      const match = [...(el.querySelectorAll?.('[data-act]') || [])].find(n =>
        Object.entries(oldFocus).every(([k,v])=>n.dataset[k]===v));
      match?.focus({preventScroll:true});
    }
  }
  const jump = (ctx,id) => ctx.element.querySelector('#tt-' + id)?.scrollIntoView({block:'start',behavior:'instant'});
  const teamDrill = (ctx, team, rider, metric, label, filters={}) =>
    ctx.drill({dimension:'team',path:rider == null?[team]:[team,rider],metric,label,filters});

  function depthChart(teams, prefs) {
    const field = {appearances:'top10_finishes',roster:'participants'}[prefs.depthSort] || 'top10_distinct_riders';
    const ordered = [...teams].sort((a,b) => b[field] - a[field] || b.top10_distinct_riders - a.top10_distinct_riders ||
      b.top10_finishes - a.top10_finishes || byName(a.team_name,b.team_name));
    const largest = Math.max(...teams.map(t=>t.participants),1);
    const lines = ordered.map(t => {
      const title = esc(t.team_name), id = t.team_key;
      const a = 100 * t.participants / largest, b = 100 * t.top10_distinct_riders / (t.participants || 1);
      const edges = '<div class="tt-barhouse" style="width:' + a + '%">' +
        btn('roster',id,'','aria-label="Starting roster for ' + title + '" title="Starting roster"','tt-roster-bar') +
        (b > 0 ? btn('contributors',id,'','aria-label="Top-10 contributors for ' + title + '" title="Top-10 contributors" style="width:' + b + '%"','tt-contributor-bar') : '') + '</div>';
      return '<div class="tt-depth-row">' + btn('roster',id,title,'','tt-team-name') + '<div class="tt-mark">' + edges + '</div>' +
        '<span class="tt-count">' + btn('contributors',id,num(t.top10_distinct_riders),'title="Top-10 contributors"') + ' / ' +
        btn('roster',id,num(t.participants),'title="Starting roster"') + '</span>' +
        btn('terrain',id,num(t.top10_finishes),'aria-label="' + num(t.top10_finishes) + ' top-10 finishes by terrain for ' + title + '"','tt-finishes') + '</div>';
    }).join('');
    return '<div class="tt-legend"><span><i></i>Top-10 riders</span><span><i></i>Starters</span></div>' +
      '<div class="tt-depth-header"><span>Team</span><span>Top-10 / starters</span><span>Top-10 finishes</span></div>' +
      '<div class="tt-depth-list" data-scroll="depth" tabindex="0" aria-label="All team depth comparisons">' + lines + '</div>';
  }

  function comparison(teams, a, b) {
    const metric = (name,format) => '<tr><th scope="row">' + name + '</th><td>' + format(a) +
      '</td>' + (b ? '<td>' + format(b) + '</td>' : '') + '</tr>';
    const panel = '<table class="tt-compare"><thead><tr><th></th><th scope="col">A</th>' + (b?'<th scope="col">B</th>':'') +
      '</tr></thead><tbody>' + metric('Stage wins',t=>btn('wins',t.team_key,num(t.wins))) +
      metric('Stages with a top 10',t=>num(t.top10_stages)+' / '+num(t.selected_stage_count)) + '</tbody></table>';
    return '<aside class="tt-compare-box"><h4>Wins and coverage</h4>' +
      select('compare-a','Team A',teamChoices(teams),a.team_key) +
      (b?select('compare-b','Team B',teamChoices(teams.filter(t=>t!==a)),b.team_key):'') + panel + '</aside>';
  }

  function rosterBlock(roster, target, prefs) {
    let riders = roster.filter(r=>prefs.rosterMode === 'all' || r.team_key===target.team_key);
    if (prefs.rosterMode === 'contributors') riders = riders.filter(r=>r.top10_count>0);
    riders.sort((a,b)=>b.top10_count-a.top10_count || b.win_count-a.win_count || byName(a.rider_name,b.rider_name));
    const max = riders[0]?.top10_count || 1;
    const modes = [['roster','Starting roster'],['contributors','Top-10 contributors'],['all','All riders']];
    const allTeams = prefs.rosterMode === 'all';
    const title = modes.find(([key]) => key === prefs.rosterMode)[1];
    return block('roster', heading(title,select('roster-mode','Show',modes,prefs.rosterMode)) +
      (allTeams ? '' : note(target.team_name)) +
      (riders.length ? table(['Rider','Nationality',...(allTeams ? ['Team'] : []),'Top-10 finishes','Wins','Stages completed'],riders.map(r=>[
        esc(r.rider_name) + (r.exit_flag?'<small class="tt-status">Exited</small>':''),
        esc(r.rider_country_name),...(allTeams ? [esc(r.team_name)] : []), '<span class="tt-bar-value">' + bar(r.top10_count,max) +
        btn('top-days',r.rider_key,num(r.top10_count),'aria-label="Top-10 days for ' + esc(r.rider_name) + '"') + '</span>',
        num(r.win_count),num(r.completed_stage_count)
      ]),true) : empty('No top-10 finishes in this scope.')));
  }
  function terrainBreakdown(ctx, roster, team) {
    const members = roster.filter(r=>r.team_key===team.team_key);
    const totals = types.map(t=>members.reduce((n,r)=>n+Number(r.terrain_top10?.[t] || 0),0));
    const max = Math.max(1,...totals);
    return block('breakdown',heading('Top-10 finishes by terrain') + note(team.team_name) +
      '<div class="tt-terrain-break">' + types.map((t,i)=>
        btn('terrain-days',team.team_key,'<span>'+terrainLabel[t]+'</span>'+bar(totals[i],max)+'<b>'+num(totals[i])+'</b><small>' +
          num(stageScope(ctx,t).length) + ' stages</small>', 'data-terrain="' + esc(t) + '"','tt-break-row')).join('') + '</div>');
  }

  function burdenBlock(teams, roster, prefs, detailRows, detailError) {
    const totals = teams.map(t=>{
      const members = roster.filter(r=>r.team_key===t.team_key);
      return {...t, members, seconds:members.reduce((v,r)=>v+Number(r.rider_burden_seconds),0),
        results:members.reduce((v,r)=>v+r.completed_stage_count,0)};
    });
    const factor = prefs.burdenSort === 'least' ? 1 : -1;
    totals.sort((a,b)=> prefs.burdenSort==='results' ? b.results-a.results || b.seconds-a.seconds :
      factor * (a.seconds-b.seconds) || byName(a.team_name,b.team_name));
    const chosen = byKey(totals,'team_key',prefs.burdenTeam);
    const summary = table(['Team','Adjusted time','Completed results'],totals.map(t=>[
      btn('burden-team',t.team_key,esc(t.team_name)),time(t.seconds),num(t.results)]),true);
    let details = '';
    if (chosen) {
      const max = Math.max(1,...chosen.members.map(r=>r.rider_burden_seconds));
      details = '<h4>' + esc(chosen.team_name) + '</h4>' + table(['Rider','Adjusted time','Share of team','Stages'],[...chosen.members]
        .sort((a,b)=>b.rider_burden_seconds-a.rider_burden_seconds).map(r=>[
          btn('burden-rider',r.rider_key,esc(r.rider_name)), '<span class="tt-bar-value">'+bar(r.rider_burden_seconds,max)+time(r.rider_burden_seconds)+'</span>',
          chosen.seconds ? num(100*r.rider_burden_seconds/chosen.seconds,1)+'%' : '—',num(r.completed_stage_count)]));
      const rider = byKey(chosen.members,'rider_key',prefs.burdenRider);
      if (rider) {
        const days = detailRows?.filter(r=>r.rider_key===rider.rider_key);
        details += '<h4 id="tt-daily">' + esc(rider.rider_name) + ' · daily adjusted time</h4>' + (detailError ? empty('Daily results unavailable. Select a rider to retry.') : days == null ? note('Loading daily results…') : days.length ?
          table(['Stage','Date','Terrain','Adjusted time',''],days.map(r=>[
            num(r.stage_id),esc(r.stage_date),esc(terrainLabel[r.stage_type]),time(r.adjusted_time_seconds),
            btn('compare-day',r.stage_id,'Compare teammates')]),true) : empty('No completed stages in this scope.'));
        const day = days?.find(r=>r.stage_id===prefs.burdenStage);
        if (day) details += '<h4 id="tt-teammates">Stage ' + num(day.stage_id) + ' · teammates</h4>' + table(['Rider','Finish rank','Adjusted time'],
          detailRows.filter(r=>r.stage_id===day.stage_id).map(r=>[esc(r.rider_name),num(r.finish_rank),time(r.adjusted_time_seconds)]));
      }
    }
    return block('burden',heading('Whole-team time burden',select('burden-sort','Order',
      [['most','Most time'],['least','Least time'],['results','Completed results']],prefs.burdenSort)) +
      note('Adjusted time adds every completed rider-stage, including days ridden before an exit.') + summary +
      (details?'<div id="tt-burden-detail">'+details+'</div>':''));
  }

  function standingsBlock(primary, alternative, prefs, filters) {
    const alternate = prefs.standingsMethod==='cumulative_top3';
    const standings = alternate ? alternative : primary;
    const comparisonMode = prefs.standingsMethod === 'compare';
    const allTeams = new Map([...primary,...alternative].map(r=>[r.team_key,r.team_name]));
    const compared = Array.from(allTeams, ([key,name])=>{
      const stage=byKey(primary,'team_key',key), cumulative=byKey(alternative,'team_key',key);
      return [esc(name),num(stage?.rank),time(stage?.total_seconds),num(stage?.contributor_count),
        num(cumulative?.rank),time(cumulative?.total_seconds),num(cumulative?.contributor_count)];
    });
    return block('standings',heading('Team standings',select('standings-method','Timing',
      [['stage_top3','Fastest three each stage'],['cumulative_top3','Fastest three over the scope'],['compare','Compare both methods']],prefs.standingsMethod)) +
      note((filters.time_basis==='finish'?'Raw':'Adjusted') + ' time · ' + (comparisonMode?'Stage selects three each day. Cumulative selects three who finished the full scope.':alternate?'Three riders must each finish all selected stages.':'Each selected stage requires three team finishers.')) +
      (comparisonMode && compared.length ? table(['Team','Stage rank','Stage time','Stage riders','Cumulative rank','Cumulative time','Cumulative riders'],compared,true) : standings.length ? table(['Rank','Team','Total time','Gap','Contributors'],standings.map(r=>
        [num(r.rank),esc(r.team_name),time(r.total_seconds),time(r.gap_seconds),num(r.contributor_count)]),true) :
        empty('No team meets the three-rider requirement in this scope.')));
  }

  pages.team_standings = async function renderTeamPage(ctx) {
    const [teams,roster,primary,alternative] = await Promise.all([
      ctx.analytics('team_depth'), ctx.report('team_roster_performance'),
      ctx.analytics('team_standings',{...ctx.filters, team_aggregation:'stage_top3'}),
      ctx.analytics('team_standings',{...ctx.filters, team_aggregation:'cumulative_top3'})
    ]);
    if (!ctx.isCurrent()) return;
    if (!teams.length) return paint(ctx,empty('No teams in this scope.'));
    const p = ctx.preferences;
    const defaultTeam = teams.find(t=>/visma/i.test(t.team_name)) || teams[0];
    p.team = (byKey(teams,'team_key',p.team ?? p.teamKey) || defaultTeam).team_key;
    p.teamA = (byKey(teams,'team_key',p.teamA) || defaultTeam).team_key;
    p.rosterMode ||= 'roster';
    p.depthSort ||= 'depth';
    p.burdenSort ||= 'most';
    const scopeMethod = ctx.filters.team_aggregation || 'stage_top3';
    if (p.lastScopeMethod !== scopeMethod) p.standingsMethod=scopeMethod;
    p.lastScopeMethod=scopeMethod;
    const cache = new Map();
    let failedTeam = null;
    let seq = 0;
    function draw() {
      const team = byKey(teams,'team_key',p.team);
      const a = byKey(teams,'team_key',p.teamA);
      const others = teams.filter(t=>t!==a);
      const b = byKey(others,'team_key',p.teamB) || others.find(t=>/UAE/i.test(t.team_name)) || others[0];
      p.teamB = b?.team_key;
      const hero = block('depth',heading('How many starters reached the top ten?',select('depth-sort','Sort teams',
        [['depth','Top-10 riders'],['appearances','Top-10 finishes'],['roster','Starting roster']],p.depthSort)) +
        '<div class="tt-hero"><div>'+depthChart(teams,p)+'</div>'+comparison(teams,a,b)+'</div>');
      paint(ctx, hero + rosterBlock(roster,team,p) + terrainBreakdown(ctx,roster,team) +
        burdenBlock(teams,roster,p,cache.get(p.burdenTeam),failedTeam === p.burdenTeam) + standingsBlock(primary,alternative,p,ctx.filters));
    }
    async function loadDays(team) {
      const token = ++seq;
      if (cache.has(team)) return;
      failedTeam = null;
      try {
        const results = await ctx.analytics('rider_stage_results',{...ctx.filters,team_keys:[team]});
        if (!ctx.isCurrent() || token!==seq) return;
        cache.set(team,results);
        draw();
      } catch (err) {
        if (!ctx.isCurrent() || token!==seq) return;
        failedTeam = team;
        draw();
      }
    }
    draw();
    bind(ctx, ({act,k,terrain},value) => {
      const key = Number(k);
      let target = '';
      if (act==='top-days') {
        const r = byKey(roster,'rider_key',key);
        if (r) teamDrill(ctx,r.team_key,r.rider_key,'top10',r.rider_name + ' · top-10 finishes');
        return;
      }
      if (act==='terrain-days') {
        ctx.drill({dimension:'terrain',path:[terrain],metric:'top10',
          filters:{...terrainFilters(ctx,terrain),team_keys:[key]},label:byKey(teams,'team_key',key).team_name+' · '+terrainLabel[terrain]+' top-10 finishes'});
        return;
      }
      if (act==='wins') return teamDrill(ctx,key,null,'wins',byKey(teams,'team_key',key).team_name+' · stage wins');
      if (act==='depth-sort') p.depthSort=value;
      if (act==='compare-a') p.teamA=Number(value);
      if (act==='compare-b') p.teamB=Number(value);
      if (act==='roster' || act==='contributors') {
        p.team=key; p.rosterMode=act; target='roster';
      }
      if (act==='terrain') { p.team=key; target='breakdown'; }
      if (act==='roster-mode') p.rosterMode=value;
      if (act==='burden-sort') p.burdenSort=value;
      if (act==='burden-team') { p.burdenTeam=key; p.burdenRider=null; p.burdenStage=null; target='burden-detail'; ++seq; }
      if (act==='burden-rider') { p.burdenRider=key; p.burdenStage=null; target='daily'; }
      if (act==='compare-day') { p.burdenStage=key; target='teammates'; }
      if (act==='standings-method') p.standingsMethod=value;
      draw();
      if (target) jump(ctx,target);
      if (act==='burden-rider') void loadDays(p.burdenTeam);
    });
    if (byKey(roster,'rider_key',p.burdenRider) && byKey(teams,'team_key',p.burdenTeam)) await loadDays(p.burdenTeam);
  };

  function entities(rows) {
    const groups = {team:new Map(),rider:new Map()};
    for (const row of rows) {
      const map = groups[row.entity_kind];
      if (!map.has(row.entity_key)) map.set(row.entity_key,{...row,cells:{}});
      map.get(row.entity_key).cells[row.stage_type] = row;
    }
    return {team:[...groups.team.values()],rider:[...groups.rider.values()]};
  }
  const moverOrder = (a,b) => Number(available(b.terrain_rank_gain))-Number(available(a.terrain_rank_gain)) ||
    Number(b.terrain_rank_gain)-Number(a.terrain_rank_gain) || byName(a.entity_name,b.entity_name);
  const entityChoices = items => [...items].sort((a,b)=>byName(a.entity_name,b.entity_name)).map(t=>[t.entity_key,t.entity_name]);
  function dotProfile(selected) {
    const speeds = selected.flatMap(e=>Object.values(e.cells).map(c=>Number(c.speed_kmh)));
    const low = Math.max(0,Math.floor((Math.min(...speeds)-1)/5)*5), high = Math.ceil((Math.max(...speeds)+1)/5)*5;
    const ticks = [high,(high+low)/2,low];
    const guides = ticks.map((v,i)=>'<div class="tt-plot-guide" style="top:'+50*i+'%"><span>'+num(v,1)+'</span></div>').join('');
    const marks = types.map(type=>'<div class="tt-plot-col">' + selected.map((e,i)=>{
      const c = e.cells[type];
      if (!c) return '';
      const y = 100 * (high-Number(c.speed_kmh)) / (high-low);
      const title = esc(e.entity_name+' · '+terrainLabel[type]+' · '+num(c.speed_kmh,2)+' km/h · ' + num(c.sample_count)+' completed results');
      return btn('profile-days',e.entity_key,'','data-terrain="'+type+'" style="top:'+y+'%;left:calc(50% + '+(selected.length===1?0:i?6:-6)+'px)" aria-label="'+title+'" title="'+title+'"','tt-dot tt-series-'+i);
    }).join('')+'</div>').join('');
    return '<div class="tt-plot-unit">km/h</div><div class="tt-plot">'+guides+marks+'</div><div class="tt-plot-labels">'+
      types.map(t=>'<span>'+terrainLabel[t]+'</span>').join('')+'</div>';
  }
  function profileBlock(subjects, selected, prefs, filters) {
    const choices = entityChoices(subjects);
    const [a,b] = selected;
    const names = prefs.entityKind==='team'?'team':'rider';
    const controls = select('entity-kind','Compare',[['rider','Riders'],['team','Teams']],prefs.entityKind);
    const selectors = '<div class="tt-profiles"><div class="tt-series-label tt-first">'+select('subject-a','First '+names,choices,a.entity_key) +
      '</div>' + (b?'<div class="tt-series-label tt-second">'+select('subject-b','Second '+names,choices.filter(([key])=>key!==a.entity_key),b.entity_key)+'</div>':'')+'</div>';
    const ordered = [...subjects].filter(r=>available(r.terrain_rank_gain)).sort(moverOrder);
    const cohortSize = ordered[0]?.ranked_entities;
    const rankScope = filters.rank_scope==='filtered' ? 'matching' : 'overall';
    const movers = '<aside class="tt-rank-side"><h4>Mountain rank gains</h4>' + (ordered.length?
      note('Flat and hilly stages form the baseline. Both ranks compare '+num(cohortSize)+' '+names+(cohortSize===1?'':'s')+' ('+rankScope+').') +
      table([prefs.entityKind==='team'?'Team':'Rider','Baseline','Mountain','Gain'],ordered.map(r=>[
        btn('focus-subject',r.entity_key,esc(r.entity_name)),num(r.baseline_rank),num(r.mountain_rank),signed(r.terrain_rank_gain)]),true) :
      empty('No matching baseline and mountain results in this scope.'))+'</aside>';
    const rankChange = e => available(e.terrain_rank_gain) ?
      '#' + num(e.baseline_rank) + ' → #' + num(e.mountain_rank) + ' (' + signed(e.terrain_rank_gain) + ')' : '—';
    const samples = selected.map((e,i)=>['<span class="tt-series-key tt-series-'+i+'"></span>'+esc(e.entity_name),
      ...types.map(t=>{const c=e.cells[t];return c ? btn('profile-days',e.entity_key,num(c.speed_kmh,2)+' <small>('+num(c.sample_count)+')</small>',
        'data-terrain="'+t+'" title="Speed in km/h and completed results"') : '—';}),rankChange(e)]);
    return block('profiles',heading('Who gains ground in the mountains?',controls) +
      '<div class="tt-profile-grid"><div>'+selectors+dotProfile(selected)+table(['km/h (results)',...types.map(t=>terrainLabel[t]),'Baseline → mountain rank'],samples)+
      note(prefs.entityKind==='team' ? 'Team speed includes every member of each matching team. Each ride contributes its distance and raw finish time.' :
        'Speed uses all kilometres ridden divided by raw finish time.')+'</div>'+movers+'</div>');
  }
  function mountainBlock(model, selected, prefs) {
    const teamMode = prefs.entityKind==='team';
    const focus = selected.find(e=>e.entity_key===prefs.mountainTeam) || selected[0];
    const riders = model.rider.filter(r=>teamMode ? r.team_key===focus.entity_key :
      prefs.evidenceScope==='all' || selected.some(e=>e.entity_key===r.entity_key));
    const mountain = r=>r.cells.mountain;
    const podiumRate = c=> c ? c.podium_count/c.sample_count : -1;
    riders.sort((a,b)=>{
      const x=mountain(a),y=mountain(b);
      if (!x || !y) return Number(!!y)-Number(!!x) || byName(a.entity_name,b.entity_name);
      if (prefs.mountainSort==='gap') return Number(x.mean_winner_gap_seconds)-Number(y.mean_winner_gap_seconds) || b.cells.mountain.sample_count-a.cells.mountain.sample_count;
      return podiumRate(y)-podiumRate(x) || y.sample_count-x.sample_count || byName(a.entity_name,b.entity_name);
    });
    let controls = select('mountain-sort','Order',[['rate','Podium frequency'],['gap','Smallest mean gap']],prefs.mountainSort);
    if (teamMode) controls = select('mountain-team','Team members',selected.map(e=>[e.entity_key,e.entity_name]),focus.entity_key)+controls;
    else controls = select('evidence-scope','Riders',[['selected','Selected profiles'],['all','All riders']],prefs.evidenceScope)+controls;
    const dayButton = (r,metric,content) => btn('mountain-days',r.entity_key,content,'data-metric="'+metric+'" title="'+
      (metric==='podiums'?'Podium days':metric==='gap'?'Daily gaps to the winner':'All completed mountain days')+'"');
    const rows = riders.map(r=>{
      const c = mountain(r);
      return [teamMode ? btn('inspect-member',r.entity_key,esc(r.entity_name)) : esc(r.entity_name),esc(r.team_name),
        c ? num(100*podiumRate(c),1)+'%' : '—', c ? dayButton(r,'podiums',num(c.podium_count))+' / '+dayButton(r,'results',num(c.sample_count)) : '0 / 0',
        c ? dayButton(r,'gap',num(c.mean_winner_gap_seconds,1)) : '—'];
    });
    return block('mountain',heading('Mountain podiums and gaps','<div class="analysis-toolbar">'+controls+'</div>') +
      note('Mean gap includes zero-second finishes.') +
      (riders.length ? table(['Rider','Team','Podium frequency','Podiums / mountain stages completed','Mean gap to stage winner (s)'],rows,true) :
        empty('No completed mountain stages in this scope.')));
  }
  pages.rider_specialisation = async function renderTerrainPage(ctx) {
    const rows = await ctx.report('terrain_performance');
    if (!ctx.isCurrent()) return;
    if (!rows.length) return paint(ctx,empty('No terrain results in this scope.'));
    const model = entities(rows), p=ctx.preferences;
    p.entityKind = p.entityKind==='team' && model.team.length ? 'team' : 'rider';
    p.mountainSort ||= 'rate';
    p.evidenceScope ||= 'selected';
    let subjects, selected, evidenceRows, evidenceFailed = false, requestNumber = 0;
    function evidenceBlock() {
      const detail = p.teamEvidence;
      const team = byKey(selected,'entity_key',detail?.team);
      if (p.entityKind!=='team' || !team || !detail) return '';
      const control = btn('close-evidence',detail.team,'Close');
      const title = team.entity_name + ' · ' + terrainLabel[detail.terrain] + ' rides';
      let body = note('Loading full-team results…');
      if (evidenceFailed) body = empty('Daily results unavailable. Select the terrain again to retry.');
      else if (evidenceRows) body = evidenceRows.length ? table(['Stage','Date','Rider','Distance (km)','Finish rank','Raw finish time','Winner gap'],
        evidenceRows.map(r=>[num(r.stage_id),esc(r.stage_date),esc(r.rider_name),num(r.distance_km,1),num(r.finish_rank),time(r.finish_time_seconds),num(r.gap_seconds)+' s']),true) :
        empty('No completed rides in this scope.');
      return block('team-evidence',heading(title,control)+body);
    }
    async function loadTeamEvidence(team, terrain, scroll) {
      const token = ++requestNumber;
      p.teamEvidence = {team,terrain};
      evidenceRows = null;
      evidenceFailed = false;
      draw();
      if (scroll) jump(ctx,'team-evidence');
      const filters = {...ctx.filters,...terrainFilters(ctx,terrain),team_keys:[team]};
      // Team profiles count all teammates. Member selectors only identify the team.
      delete filters.rider_keys;
      delete filters.young_only;
      try {
        const records = await ctx.analytics('rider_stage_results',filters);
        if (!ctx.isCurrent() || token!==requestNumber) return;
        evidenceRows = records;
      } catch {
        if (!ctx.isCurrent() || token!==requestNumber) return;
        evidenceFailed = true;
      }
      draw();
    }
    function draw() {
      subjects = model[p.entityKind];
      if (!subjects.length) {
        selected = [];
        const label = p.entityKind==='team' ? 'teams' : 'riders';
        const control = select('entity-kind','Compare',[['rider','Riders'],['team','Teams']],p.entityKind);
        paint(ctx,block('profiles',heading('Who gains ground in the mountains?',control) +
          empty('No '+label+' completed a stage in this scope.')));
        return;
      }
      const defaultA = subjects.find(r=>(p.entityKind==='team'?/visma/i:/poga/i).test(r.entity_name));
      const a = byKey(subjects,'entity_key',p[p.entityKind+'A']) || defaultA || subjects[0];
      const others = subjects.filter(r=>r.entity_key!==a.entity_key);
      const b = byKey(others,'entity_key',p[p.entityKind+'B']) || others.find(r=>(p.entityKind==='team'?/UAE/i:/vingegaard/i).test(r.entity_name)) || others[0];
      selected = b ? [a,b] : [a];
      p[p.entityKind+'A']=a.entity_key;
      p[p.entityKind+'B']=b?.entity_key;
      paint(ctx,profileBlock(subjects,selected,p,ctx.filters)+evidenceBlock()+mountainBlock(model,selected,p));
    }
    draw();
    bind(ctx,({act,k,terrain,metric},value)=>{
      const key = Number(k);
      if (act==='profile-days') {
        const subject = byKey(subjects,'entity_key',key);
        if (p.entityKind==='team' && (Array.isArray(ctx.filters.rider_keys) || ctx.filters.young_only))
          return void loadTeamEvidence(key,terrain,true);
        return ctx.drill({dimension:'terrain',path:[terrain],metric:'results',
          filters:{...terrainFilters(ctx,terrain),...(p.entityKind==='team'?{team_keys:[key]}:{rider_keys:[key]})},label:subject.entity_name+' · '+terrainLabel[terrain]+' results'});
      }
      if (act==='mountain-days') {
        const r=byKey(model.rider,'entity_key',key);
        return teamDrill(ctx,r.team_key,key,metric,r.entity_name+' · mountain '+
          ({podiums:'podium days',gap:'winner gaps',results:'finishes'})[metric],terrainFilters(ctx,'mountain'));
      }
      if (['close-evidence','entity-kind','subject-a','subject-b','focus-subject','inspect-member'].includes(act)) {
        ++requestNumber;
        delete p.teamEvidence;
      }
      if (act==='entity-kind') p.entityKind=value;
      if (act==='subject-a') p[p.entityKind+'A']=Number(value);
      if (act==='subject-b') p[p.entityKind+'B']=Number(value);
      if (act==='focus-subject') p[p.entityKind+'A']=key;
      if (act==='evidence-scope') p.evidenceScope=value;
      if (act==='mountain-sort') p.mountainSort=value;
      if (act==='mountain-team') p.mountainTeam=Number(value);
      if (act==='inspect-member') { p.entityKind='rider'; p.riderA=key; }
      draw();
      if (act==='inspect-member') jump(ctx,'profiles');
    });
    if (p.teamEvidence && p.entityKind==='team' && byKey(selected,'entity_key',p.teamEvidence.team))
      await loadTeamEvidence(p.teamEvidence.team,p.teamEvidence.terrain,false);
  };
})();

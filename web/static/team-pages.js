(() => {
  'use strict';

  const pages = window.RacePages ||= {};
  const types = ['flat', 'hilly', 'mountain', 'individual time-trial'];
  const terrainLabel = {flat:'Flat', hilly:'Hilly', mountain:'Mountain', 'individual time-trial':'Individual Time Trial'};
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
      if (event.type === 'click' && ['SELECT','INPUT'].includes(target.tagName)) return;
      handler(target.dataset, target.value);
    };
    ctx.element.onclick = dispatch;
    ctx.element.onchange = dispatch;
  }
  function paint(ctx, html, teamPage=false) {
    if (!ctx.isCurrent()) return;
    const el = ctx.element, focused = el.ownerDocument?.activeElement;
    const oldFocus = focused && el.contains(focused) ? focused.dataset : null;
    const oldScroll = Array.from(el.querySelectorAll?.('[data-scroll]') || [], n => [n.dataset.scroll,n.scrollTop]);
    el.innerHTML = '<div class="analysis-page tt-page' + (teamPage ? ' tt-team-page' : '') + '">' + html + '</div>';
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
  function jump(ctx,id) {
    const target = ctx.element.querySelector('#tt-' + id);
    if (!target) return;
    target.scrollIntoView({block:'start',behavior:'instant'});
    const heading = target.querySelector('h3,h4');
    heading?.setAttribute('tabindex','-1');
    heading?.focus({preventScroll:true});
  }
  const teamDrill = (ctx, team, rider, metric, label, filters={}) =>
    ctx.drill({dimension:'team',path:rider == null?[team]:[team,rider],metric,label,filters});

  const icons = {
    trophy:'M8 4h8v6a4 4 0 0 1-8 0V4ZM8 6H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4m-4 2v5m-4 1h8',
    route:'M4 17l8-10 8 10M4 17h.01M12 7h.01M20 17h.01',
    riders:'M3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2m2-6a4 4 0 0 1 4 4v2M12 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm4-3a3 3 0 0 1 0 6',
    timer:'M12 8v5l3 2M9 2h6m-3 2v2m6 1 2-2m0 9a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
    flat:'M3 16h18', hilly:'M3 17q4-10 8-4t10-3', mountain:'M3 19 12 5l9 14M9 10l3 3 3-3',
    arrow:'M5 12h14m-6-6 6 6-6 6'
  };
  const icon = name => '<svg class="tt-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="' + icons[name] + '"/></svg>';
  const evidence = (act,key,label,name) => btn(act,key,label+icon('arrow'),'aria-label="'+esc(name)+'"','analysis-link tt-evidence');
  const slot = (team,a,b) => team===a ? 'a' : team===b ? 'b' : 'neutral';

  function comparison(teams, a, b) {
    const selected = b ? [a,b] : [a];
    const metrics = [
      ['Stage wins','trophy','wins',null,'wins'],
      ['Top-10 stage coverage','route','top10_stages','selected_stage_count','coverage'],
      ['Riders with a top-10 finish','riders','top10_distinct_riders','participants','contributors']
    ];
    return '<div class="tt-broadcast"><div class="tt-pair-controls">' +
      selected.map((t,i) => '<div class="tt-slot-'+slot(t,a,b)+'"><strong><i class="tt-swatch"></i>'+esc(t.team_name)+'</strong>'+
        select(i?'compare-b':'compare-a',i?'Team B':'Team A',teamChoices(teams),t.team_key)+'</div>').join('') +
      '</div>'+metrics.map(([label,symbol,field,denom,action]) => {
        const max = Math.max(1,...selected.map(t=>Number(t[field])));
        return '<div class="tt-broadcast-metric"><h4>'+icon(symbol)+esc(label)+'</h4><div class="tt-pair-values">'+
          selected.map(t => {
            const base = denom ? t[denom] : max;
            const value = base ? num(t[field]) + (denom ? ' / '+num(base) : '') : '—';
            const display = base && t[field]>0 ? evidence(action,t.team_key,value,t.team_name+' · '+label+' · '+value) : value;
            return '<div class="tt-slot-'+slot(t,a,b)+'"><strong>'+display+'</strong>'+
              bar(t[field],base)+'</div>';
      }).join('')+'</div></div>';
      }).join('')+note('Select a number marked → to see the results behind it.')+'</div>';
  }

  function performanceTable(teams,prefs) {
    const columns = [
      ['team_name','Team'],['wins','Stage wins'],['coverage','Top-10 stage coverage'],
      ['top10_finishes','Top-10 finishes'],['top10_distinct_riders','Top-10 riders'],['participants','Starters']
    ];
    const field = prefs.teamSort || 'coverage';
    const direction = prefs.teamAscending ? 1 : -1;
    const value = t => field==='coverage' ? (t.top10_stages / (t.selected_stage_count || 1)) : t[field];
    const rows = teams.filter(t=>t.team_name.toLowerCase().includes((prefs.teamSearch || '').toLowerCase()))
      .sort((a,b)=>(field==='team_name' ? direction*byName(a.team_name,b.team_name) :
        direction*(value(a)-value(b)) || byName(a.team_name,b.team_name)));
    const ratio = (v,d) => d ? num(v)+' / '+num(d) : '—';
    return '<details class="tt-all-teams"'+(prefs.teamsOpen?' open':'')+'><summary>All teams · '+num(teams.length)+'</summary>'+
      '<label class="tt-control">Find team <input type="search" data-act="team-search" value="'+esc(prefs.teamSearch || '')+'"></label>'+
      '<div class="analysis-table-wrap tt-scroll"><table class="analysis-table"><thead><tr>'+
      columns.map(([key,label])=>'<th scope="col"'+(key===field?' aria-sort="'+(direction===1?'ascending':'descending')+'"':'')+'>'+
        btn('team-sort',key,esc(label))+'</th>').join('')+'</tr></thead><tbody>'+
      rows.map(t=>'<tr>'+[
        btn('matrix-team',t.team_key,esc(t.team_name))+' '+btn('add-compare',t.team_key,'Compare',
          'aria-label="'+esc('Compare '+t.team_name)+'"','analysis-link tt-compare-action'),
        num(t.wins),ratio(t.top10_stages,t.selected_stage_count),
        t.top10_finishes ? evidence('terrain',t.team_key,num(t.top10_finishes),'View top-10 finishes for '+t.team_name) : '0',
        ratio(t.top10_distinct_riders,t.participants),num(t.participants)
      ].map(x=>'<td>'+x+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>'+
      (rows.length ? '' : empty('No matching teams.'))+'</details>';
  }

  function rosterBlock(roster, target, prefs) {
    let riders = roster.filter(r=>prefs.rosterMode === 'all' || r.team_key===target.team_key);
    if (prefs.rosterMode === 'contributors') riders = riders.filter(r=>r.top10_count>0);
    riders.sort((a,b)=>b.top10_count-a.top10_count || b.win_count-a.win_count || byName(a.rider_name,b.rider_name));
    const max = riders[0]?.top10_count || 1;
    const modes = [['roster','Starting roster'],['contributors','Top-10 contributors'],['all','All riders']];
    const allTeams = prefs.rosterMode === 'all';
    if (allTeams) riders = riders.filter(r=>[r.rider_name,r.team_name,r.rider_country_name]
      .some(value=>String(value).toLowerCase().includes((prefs.riderSearch || '').toLowerCase())));
    if (allTeams && prefs.riderSort==='name') riders.sort((a,b)=>byName(a.rider_name,b.rider_name));
    if (allTeams && prefs.riderSort==='wins') riders.sort((a,b)=>b.win_count-a.win_count);
    const title = modes.find(([key]) => key === prefs.rosterMode)[1];
    return block('roster', heading(title,select('roster-mode','Show',modes,prefs.rosterMode)) +
      (allTeams ? '<label class="tt-control">Find rider <input type="search" data-act="rider-search" value="'+esc(prefs.riderSearch || '')+'"></label> '+
        select('rider-sort','Order',[['top10','Top-10 finishes'],['wins','Stage wins'],['name','Rider name']],prefs.riderSort || 'top10') : '')+
      (allTeams ? '' : note(target.team_name)) +
      (riders.length ? table(['Rider','Nationality',...(allTeams ? ['Team'] : []),'Top-10 finishes','Wins','Stages completed'],riders.map(r=>[
        esc(r.rider_name) + (r.exit_flag?'<small class="tt-status">Exited</small>':''),
        esc(r.rider_country_name),...(allTeams ? [esc(r.team_name)] : []), '<span class="tt-bar-value">' + bar(r.top10_count,max) +
        (r.top10_count ? evidence('top-days',r.rider_key,num(r.top10_count),'Top-10 days for '+r.rider_name) : '0') + '</span>',
        num(r.win_count),num(r.completed_stage_count)
      ]),true) : empty('No top-10 finishes in this scope.')));
  }

  function stageMatrix(ctx,team,roster,rows,prefs,failed) {
    const stages = stageScope(ctx).slice().sort((a,b)=>a.stage_order-b.stage_order);
    const selected = roster.filter(r=>r.team_key===team.team_key);
    if (!rows) return note(failed ? 'Stage results could not load. Choose Retry to try again.' : 'Loading stage results…')+
      (failed ? btn('matrix-team',team.team_key,'Retry') : '');
    if (!stages.length || !selected.length) return empty('No matching riders or stages.');
    const byRide = new Map(rows.map(r=>[r.rider_key+':'+r.stage_id,r]));
    const ride = byRide.get(prefs.matrixRide);
    const show = r=>[esc(r.rider_name),num(r.finish_rank),time(r.adjusted_time_seconds),time(r.finish_time_seconds)];
    const coverage = prefs.coverage ? '<div class="tt-coverage"><h4>Top-10 stage coverage · '+esc(team.team_name)+'</h4>'+
      stages.map(s=>{
        const top = rows.filter(r=>r.stage_id===s.stage_id && r.finish_rank<=10);
        return top.length ? '<details><summary>Stage '+s.stage_id+' · '+top.length+' top-10 '+(top.length===1?'finish':'finishes')+'</summary>'+
          table(['Rider','Rank','Adjusted time','Raw time'],top.map(show))+'</details>' : '';
      }).join('')+'</div>' : '';
    return coverage+'<div class="tt-matrix-wrap" data-scroll="matrix" tabindex="0" aria-label="Rider results by stage"><table class="tt-matrix"><thead><tr><th scope="col">Rider</th>'+
      stages.map(s=>'<th scope="col" title="'+esc(terrainLabel[s.stage_type])+'">'+
        icon(s.stage_type==='individual time-trial'?'timer':s.stage_type)+'<span aria-label="'+esc('Stage '+s.stage_id+' '+terrainLabel[s.stage_type])+'">S'+s.stage_id+'</span></th>').join('')+
      '</tr></thead><tbody>'+selected.map(r=>'<tr><th scope="row">'+esc(r.rider_name)+'</th>'+
        stages.map(s=>{
          const key = r.rider_key+':'+s.stage_id;
          const result = byRide.get(key);
          return result ? '<td>'+btn('matrix-ride',key,num(result.finish_rank),
            'aria-label="'+esc(r.rider_name+', Stage '+s.stage_id+', rank '+result.finish_rank)+'"',
            result.finish_rank<=10?'tt-matrix-top':'tt-matrix-finish')+'</td>' : '<td class="tt-matrix-missing">—</td>';
        }).join('')+'</tr>').join('')+'</tbody></table></div>'+
      note('Highlighted · Top ten  /  Number · Completed  /  — · No result')+
      '<div class="tt-stage-legend">'+types.map(type=>'<span>'+icon(type==='individual time-trial'?'timer':type)+esc(terrainLabel[type])+'</span>').join('')+'</div>'+
      (ride ? '<div id="tt-matrix-evidence"><h4>Stage '+ride.stage_id+' · '+esc(ride.rider_name)+'</h4>'+
        table(['Rider','Rank','Adjusted time','Raw time'],[show(ride)])+
        btn('matrix-drill',prefs.matrixRide,'Open in Drill Down '+icon('arrow'))+
        '<details><summary>Same-stage teammates in this view</summary>'+
        table(['Rider','Rank','Adjusted time','Raw time'],rows.filter(r=>r.stage_id===ride.stage_id).map(show))+'</details></div>' : '');
  }
  function terrainBreakdown(ctx, roster, team) {
    const members = roster.filter(r=>r.team_key===team.team_key);
    const totals = types.map(t=>members.reduce((n,r)=>n+Number(r.terrain_top10?.[t] || 0),0));
    const max = Math.max(1,...totals);
    return block('breakdown',heading('Top-10 Finishes by Stage Type') + note(team.team_name) +
      '<div class="tt-terrain-break">' + types.map((t,i)=>
        btn('terrain-days',team.team_key,'<span>'+terrainLabel[t]+'</span>'+bar(totals[i],max)+'<b>'+num(totals[i])+'</b><small>' +
          num(stageScope(ctx,t).length) + ' stages</small>', 'data-terrain="' + esc(t) + '"','tt-break-row')).join('') + '</div>');
  }

  function burdenSummary(teams, roster, prefs) {
    const totals = teams.map(t=>{
      const members = roster.filter(r=>r.team_key===t.team_key);
      return {...t, members, seconds:members.reduce((v,r)=>v+Number(r.rider_burden_seconds),0),
        results:members.reduce((v,r)=>v+r.completed_stage_count,0)};
    });
    const factor = prefs.burdenSort === 'least' ? 1 : -1;
    totals.sort((a,b)=> prefs.burdenSort==='results' ? b.results-a.results || b.seconds-a.seconds :
      factor * (a.seconds-b.seconds) || byName(a.team_name,b.team_name));
    const summary = table(['Team','Adjusted time','Completed results'],totals.map(t=>[
      btn('burden-team',t.team_key,esc(t.team_name)),time(t.seconds),num(t.results)]),true);
    return block('burden',heading('Combined Time by Team',select('burden-sort','Order',
      [['most','Most time'],['least','Least time'],['results','Completed results']],prefs.burdenSort)) +
      note('Adds the adjusted time of every completed ride in the selected stages, including rides before a withdrawal. Fewer completed rides can mean a lower total.') +
      note('Select a team to see how its total is split across riders.') + summary);
  }

  function riderTimeBlock(team, roster, prefs, detailRows, detailError) {
    const members = roster.filter(r=>r.team_key===team.team_key);
    const total = members.reduce((sum,r)=>sum+Number(r.rider_burden_seconds),0);
    let details = '';
    if (members.length) {
      const max = Math.max(1,...members.map(r=>r.rider_burden_seconds));
      details = table(['Rider','Adjusted time','Share of team','Stages'],[...members]
        .sort((a,b)=>b.rider_burden_seconds-a.rider_burden_seconds).map(r=>[
          btn('burden-rider',r.rider_key,esc(r.rider_name)), '<span class="tt-bar-value">'+bar(r.rider_burden_seconds,max)+time(r.rider_burden_seconds)+'</span>',
          total ? num(100*r.rider_burden_seconds/total,1)+'%' : '—',num(r.completed_stage_count)]));
      const rider = byKey(members,'rider_key',prefs.burdenRider);
      if (rider) {
        const days = detailRows?.filter(r=>r.rider_key===rider.rider_key);
        details += '<h4 id="tt-daily">' + esc(rider.rider_name) + ' · daily adjusted time</h4>' + (detailError ? empty('Daily results unavailable. Select a rider to retry.') : days == null ? note('Loading daily results…') : days.length ?
          table(['Stage','Date','Stage Type','Adjusted Time',''],days.map(r=>[
            num(r.stage_id),esc(r.stage_date),esc(terrainLabel[r.stage_type]),time(r.adjusted_time_seconds),
            btn('compare-day',r.stage_id,'Compare teammates')]),true) : empty('No completed stages in this scope.'));
        const day = days?.find(r=>r.stage_id===prefs.burdenStage);
        if (day) details += '<h4 id="tt-teammates">Stage ' + num(day.stage_id) + ' · teammates</h4>' + table(['Rider','Finish rank','Adjusted time'],
          detailRows.filter(r=>r.stage_id===day.stage_id).map(r=>[esc(r.rider_name),num(r.finish_rank),time(r.adjusted_time_seconds)]));
      }
    }
    return block('rider-time',heading('Rider Time Contributions · '+team.team_name)+
      (details ? note('Combined adjusted time · '+time(total)+' · Shares use all completed rides in this team view.')+details :
        empty('No matching riders in this scope.')));
  }

  function standingsBlock(teams, primary, alternative, a, b, focus, filters) {
    const rows = teams.map(team=>({
      team, left:byKey(primary,'team_key',team.team_key), right:byKey(alternative,'team_key',team.team_key)
    })).sort((x,y)=>(x.left?.rank ?? Infinity)-(y.left?.rank ?? Infinity) || byName(x.team.team_name,y.team.team_name));
    const moves = rows.filter(r=>r.left && r.right && r.left.rank!==r.right.rank)
      .sort((x,y)=>Number(Math.min(y.left.rank,y.right.rank)<=5)-Number(Math.min(x.left.rank,x.right.rank)<=5) ||
        Math.abs(y.left.rank-y.right.rank)-Math.abs(x.left.rank-x.right.rank));
    const featured = [...new Set([...rows.filter(r=>[a,b,focus].includes(r.team)),...moves,
      ...rows.filter(r=>r.left || r.right)])].slice(0,6);
    const ranks = [...new Set(featured.flatMap(r=>[r.left?.rank,r.right?.rank]).filter(available))].sort((x,y)=>x-y);
    const y = rank => 22+ranks.indexOf(rank)*32;
    const chart = ranks.length ? '<div class="tt-rank-comparison"><div class="tt-rank-labels"><b>'+icon('timer')+
      'Fastest three each stage</b><b>'+icon('timer')+'Fastest three over the selected stages</b></div>'+
      '<svg role="img" aria-label="Team rank comparison" viewBox="0 0 600 '+(ranks.length*32+12)+'">'+
      featured.filter(r=>r.left && r.right).map(({team,left,right})=>'<g class="tt-slot-'+slot(team,a,b)+'"><title>'+
        esc(team.team_name)+' · '+left.rank+' to '+right.rank+'</title><path d="M55 '+y(left.rank)+' L545 '+y(right.rank)+
        '" fill="none" stroke="currentColor" stroke-width="3"/></g>').join('')+
      ranks.map(rank=>'<g><text x="12" y="'+(y(rank)+4)+'">#'+rank+'</text><text x="560" y="'+(y(rank)+4)+'">#'+rank+'</text></g>').join('')+
      '</svg><div class="tt-rank-legend">'+featured.map(({team,left,right})=>{
        const gain = left && right ? left.rank-right.rank : 0;
        return btn('matrix-team',team.team_key,'<i class="tt-swatch"></i>'+esc(team.team_name)+' <b>'+
          (left?.rank ?? '—')+' → '+(right?.rank ?? '—')+(gain?' · '+(gain>0?'↑ ':'↓ ')+Math.abs(gain):'')+
          '</b>','','analysis-link tt-slot-'+slot(team,a,b));
      }).join('')+'</div></div>' : '';
    const columns = (row,method) => row ? [num(row.rank),time(row.total_seconds),
      row.gap_seconds < 60 ? num(row.gap_seconds)+' s' : time(row.gap_seconds),
      evidence('scoring-'+method,row.team_key,num(row.contributor_count),'View '+row.team_name+' scoring riders · '+method)] :
      ['—','—','—','—'];
    return block('standings',heading('Team Standings')+
      note((filters.time_basis==='finish'?'Raw':'Adjusted')+' time · Stage method can change riders each day. Cumulative method uses the same three riders who completed every selected stage.')+
      chart+table(['Team','Stage rank','Stage time','Stage gap','Stage riders','Cumulative rank','Cumulative time','Cumulative gap','Cumulative riders'],
        rows.map(({team,left,right})=>[btn('matrix-team',team.team_key,esc(team.team_name)),
          ...columns(left,'stage_top3'),...columns(right,'cumulative_top3')]),true)+
      note('— No eligible standing in this scope.'));
  }

  function scoringBlock(team,prefs,report) {
    const method = prefs.scoringMethod;
    const cumulative = method==='cumulative_top3';
    const title = cumulative ? 'Fastest three over the selected stages' : 'Fastest three each stage';
    let body = note('Loading scoring results…');
    if (report?.error) body = note('Scoring results could not load.')+btn('scoring-'+method,team.team_key,'Retry');
    if (report?.rows) {
      const entry = byKey(report.rows,'team_key',team.team_key);
      if (!entry?.scoring?.length) body = empty('No eligible standing in this scope.');
      else {
        const groups = new Map();
        for (const row of entry.scoring) {
          const key = cumulative ? row.rider_key : row.stage_id;
          if (!groups.has(key)) groups.set(key,[]);
          groups.get(key).push(row);
        }
        const sorted = [...groups.values()].sort((a,b)=>cumulative ?
          a[0].scoring_order-b[0].scoring_order : a[0].stage_id-b[0].stage_id);
        body = note((entry.time_basis==='finish'?'Raw':'Adjusted')+' time · '+time(entry.total_seconds)+' total · '+
          entry.stage_count+' stages · '+entry.contributor_count+' scoring riders')+
          select('scoring-group',cumulative?'Scoring rider':'Stage',sorted.map(rows=>[
            cumulative ? rows[0].rider_key : rows[0].stage_id,
            cumulative ? rows[0].rider_name : 'Stage '+rows[0].stage_id
          ]),prefs.scoringGroup ?? (cumulative?sorted[0][0].rider_key:sorted[0][0].stage_id))+
          sorted.filter(rows=>String(cumulative?rows[0].rider_key:rows[0].stage_id)===String(prefs.scoringGroup ??
            (cumulative?sorted[0][0].rider_key:sorted[0][0].stage_id))).map(rows=>
            note('Subtotal · '+time(rows.reduce((sum,row)=>sum+Number(row.scoring_seconds),0)))+
            table(['Stage','Rider','Finish rank','Scoring time','Status'],rows.map(row=>[
              num(row.stage_id),esc(row.rider_name),num(row.finish_rank),time(row.scoring_seconds),'<span class="tt-counted">Counted</span>'
            ]))).join('');
        if (cumulative) body = table(['Scoring rider','Total time'],sorted.map(rows=>[
          btn('scoring-rider',rows[0].rider_key,esc(rows[0].rider_name)),time(rows.reduce((sum,row)=>sum+Number(row.scoring_seconds),0))
        ]))+body;
      }
    }
    return block('scoring',heading('Scoring Riders · '+team.team_name,btn('close-scoring','','Close'))+
      select('scoring-method','Timing method',[['stage_top3','Fastest three each stage'],
        ['cumulative_top3','Fastest three over the selected stages']],method)+
      note(title+'. Only rides counted in Team Standings appear here.')+body);
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
    const defaultTeam = teams.find(t=>/uae/i.test(t.team_name)) || teams[0];
    p.team = (byKey(teams,'team_key',p.team ?? p.teamKey) || defaultTeam).team_key;
    p.teamA = (byKey(teams,'team_key',p.teamA) || defaultTeam).team_key;
    p.rosterMode ||= 'roster';
    p.burdenSort ||= 'most';
    const cache = new Map();
    const scoring = new Map();
    const pendingTeams = new Set();
    const failedTeams = new Set();
    function draw() {
      const team = byKey(teams,'team_key',p.team);
      const a = byKey(teams,'team_key',p.teamA);
      const others = teams.filter(t=>t!==a);
      const b = byKey(others,'team_key',p.teamB) || others.find(t=>/visma/i.test(t.team_name)) || others[0];
      p.teamB = b?.team_key;
      const count = stageScope(ctx).length;
      const scope = note(num(count)+' selected stages · '+(ctx.filters.rank_scope==='filtered'?'Matching-group ranks':'Overall ranks'));
      const hero = block('depth',heading('Who wins, and who stays near the front?')+
        comparison(teams,a,b)+performanceTable(teams,p));
      const view = p.scoringMethod ? 'scoring' : p.showBurden ? 'burden' : 'matrix';
      const contributions = block('contributions',heading('Riders & Contributions',
        select('matrix-team','Team',teamChoices(teams),team.team_key))+
        select('contribution-view','View',[['matrix','Stage matrix'],['scoring','Team standings scoring rides'],['burden','Rider time contributions']],view)+
        (view==='scoring' ? scoringBlock(team,p,scoring.get(p.scoringMethod)) :
          view==='burden' ? riderTimeBlock(team,roster,p,cache.get(team.team_key),failedTeams.has(team.team_key)) :
          stageMatrix(ctx,team,roster,cache.get(team.team_key),p,failedTeams.has(team.team_key))));
      paint(ctx, scope+hero+standingsBlock(teams,primary,alternative,a,b,team,ctx.filters)+contributions+
        (view==='matrix' ? rosterBlock(roster,team,p)+terrainBreakdown(ctx,roster,team)+burdenSummary(teams,roster,p) : ''),true);
      ctx.element.querySelector('.tt-all-teams')?.addEventListener('toggle',e=>{p.teamsOpen=e.target.open;});
    }
    async function loadDays(team) {
      if (cache.has(team) || pendingTeams.has(team)) return;
      pendingTeams.add(team);
      failedTeams.delete(team);
      try {
        const results = await ctx.analytics('rider_stage_results',{...ctx.filters,team_keys:[team]});
        cache.set(team,results);
      } catch {
        failedTeams.add(team);
      } finally {
        pendingTeams.delete(team);
      }
      if (ctx.isCurrent() && team===p.team) draw();
    }
    async function loadScoring(method) {
      if (scoring.has(method) && !scoring.get(method).error) return;
      scoring.set(method,{pending:true});
      try {
        scoring.set(method,{rows:await ctx.report('team_scoring',{...ctx.filters,team_aggregation:method})});
      } catch {
        scoring.set(method,{error:true});
      }
      if (ctx.isCurrent() && p.scoringMethod===method) draw();
    }
    draw();
    bind(ctx, ({act,k,terrain},value) => {
      const key = Number(k);
      let target = '';
      if (act==='team-sort') {
        p.teamAscending=p.teamSort===k ? !p.teamAscending : k==='team_name';
        p.teamSort=k; p.teamsOpen=true;
      }
      if (act==='team-search') { p.teamSearch=value; p.teamsOpen=true; }
      if (act==='rider-search') p.riderSearch=value;
      if (act==='rider-sort') p.riderSort=value;
      if (act==='add-compare' && key!==p.teamA) {p.teamB=key; p.teamsOpen=true;}
      if (act==='matrix-team' || act==='coverage') {
        p.team=Number(value || key); p.matrixRide=null;
        if (value && p.showBurden) {
          p.burdenRider=null; p.burdenStage=null;
          return draw();
        }
        if (value && p.scoringMethod) { p.scoringGroup=null; return draw(); }
        p.scoringMethod=null; p.showBurden=false;
        p.coverage=act==='coverage'; target='contributions';
      }
      if (act==='contribution-view') {
        p.showBurden=value==='burden';
        p.scoringMethod=value==='scoring' ? ctx.filters.team_aggregation || 'stage_top3' : null;
        if (value==='burden') { p.burdenRider=null; p.burdenStage=null; }
        if (value==='scoring') p.scoringGroup=null;
      }
      if (act==='scoring-stage_top3' || act==='scoring-cumulative_top3') {
        p.team=key; p.showBurden=false; p.scoringMethod=act.slice('scoring-'.length); p.scoringGroup=null; target='contributions';
      }
      if (act==='scoring-method') { p.scoringMethod=value; p.scoringGroup=null; }
      if (act==='scoring-group' || act==='scoring-rider') p.scoringGroup=value || key;
      if (act==='close-scoring') {p.scoringMethod=null; target='contributions';}
      if (act==='matrix-ride') { p.matrixRide=k; target='matrix-evidence'; }
      if (act==='matrix-drill') {
        const [rider,stage]=k.split(':').map(Number);
        return teamDrill(ctx,p.team,rider,'results','Stage '+stage+' · rider results',{stage_scope:'selection',stage_ids:[stage]});
      }
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
      if (act==='compare-a') { if (Number(value)===p.teamB) p.teamB=p.teamA; p.teamA=Number(value); }
      if (act==='compare-b') { if (Number(value)===p.teamA) p.teamA=p.teamB; p.teamB=Number(value); }
      if (act==='roster' || act==='contributors') {
        p.team=key; p.rosterMode=act; p.scoringMethod=null; p.showBurden=false; p.matrixRide=null; target='roster';
      }
      if (act==='terrain') { p.team=key; p.scoringMethod=null; p.showBurden=false; p.matrixRide=null; target='breakdown'; }
      if (act==='roster-mode') p.rosterMode=value;
      if (act==='burden-sort') p.burdenSort=value;
      if (act==='burden-team') { p.team=key; p.showBurden=true; p.burdenRider=null; p.burdenStage=null; target='contributions'; }
      if (act==='burden-rider') { p.burdenRider=key; p.burdenStage=null; target='daily'; }
      if (act==='compare-day') { p.burdenStage=key; target='teammates'; }
      draw();
      if (target) jump(ctx,target);
      if (act==='burden-rider') void loadDays(p.team);
      if (!p.showBurden && !p.scoringMethod &&
          ['matrix-team','coverage','roster','contributors','terrain','close-scoring','contribution-view'].includes(act)) void loadDays(p.team);
      if (p.scoringMethod) void loadScoring(p.scoringMethod);
    });
    if (p.showBurden && byKey(roster,'rider_key',p.burdenRider)?.team_key===p.team) await loadDays(p.team);
    if (!p.showBurden && !p.scoringMethod) void loadDays(p.team);
    if (p.scoringMethod) { p.scoringGroup=null; void loadScoring(p.scoringMethod); }
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
    const movers = '<aside class="tt-rank-side"><h4>Mountain Rank Gains</h4>' + (ordered.length?
      note('Flat and hilly stages form the baseline. Both ranks compare '+num(cohortSize)+' '+names+(cohortSize===1?'':'s')+' ('+rankScope+').') +
      table([prefs.entityKind==='team'?'Team':'Rider','Baseline','Mountain','Gain'],ordered.map(r=>[
        btn('focus-subject',r.entity_key,esc(r.entity_name)),num(r.baseline_rank),num(r.mountain_rank),signed(r.terrain_rank_gain)]),true) :
      empty('No matching baseline and mountain results in this scope.'))+'</aside>';
    const rankChange = e => available(e.terrain_rank_gain) ?
      '#' + num(e.baseline_rank) + ' → #' + num(e.mountain_rank) + ' (' + signed(e.terrain_rank_gain) + ')' : '—';
    const samples = selected.map((e,i)=>['<span class="tt-series-key tt-series-'+i+'"></span>'+esc(e.entity_name),
      ...types.map(t=>{const c=e.cells[t];return c ? btn('profile-days',e.entity_key,num(c.speed_kmh,2)+' <small>('+num(c.sample_count)+')</small>',
        'data-terrain="'+t+'" title="Speed in km/h and completed results"') : '—';}),rankChange(e)]);
    return block('profiles',heading('Who Gains Ground in the Mountains?',controls) +
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
    return block('mountain',heading('Mountain Podiums and Gaps','<div class="analysis-toolbar">'+controls+'</div>') +
      note('Mean gap includes zero-second finishes.') +
      (riders.length ? table(['Rider','Team','Podium frequency','Podiums / mountain stages completed','Mean gap to stage winner (s)'],rows,true) :
        empty('No completed mountain stages in this scope.')));
  }
  pages.rider_specialisation = async function renderTerrainPage(ctx) {
    const rows = await ctx.report('terrain_performance');
    if (!ctx.isCurrent()) return;
    if (!rows.length) return paint(ctx,empty('No stage type results in this scope.'));
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
      if (evidenceFailed) body = empty('Daily results unavailable. Select the stage type again to retry.');
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
        paint(ctx,block('profiles',heading('Who Gains Ground in the Mountains?',control) +
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

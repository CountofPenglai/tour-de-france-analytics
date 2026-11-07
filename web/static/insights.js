/* Chart-led interpretations of existing API aggregates. Rankings stay server-owned.
   Display summaries sum disjoint terrain cells or compare daily gap changes only. */
(function(root){
  'use strict';
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const terrains=['flat','hilly','mountain','individual time-trial'];
  const labels={flat:'Flat',hilly:'Hilly',mountain:'Mountain','individual time-trial':'Time trial'};
  const colors=['#087e79','#ba632b','#446caa','#8064a7','#1c425a'];
  const has=v=>v!==null&&v!==undefined&&Number.isFinite(Number(v));
  const num=v=>has(v)?Number(v).toLocaleString('en-GB'):'—';
  const percent=v=>has(v)?`${Math.round(Number(v)*100)}%`:'—';
  const time=v=>has(v)?`${Math.floor(Math.round(Math.abs(v))/60)}:${String(Math.round(Math.abs(v))%60).padStart(2,'0')}`:'—';
  const same=(a,b)=>String(a)===String(b);
  const short=name=>String(name||'').replace('TEAM VISMA | LEASE A BIKE','Visma | Lease a Bike').replace('UAE TEAM EMIRATES XRG','UAE Team Emirates XRG');
  const empty=()=>'<div class="story-empty"><p>No results in this scope.</p><span>Adjust the filters to compare performances.</span></div>';
  const metric=(label,value,tone='')=>`<div class="story-metric ${tone}"><strong>${escape(value)}</strong><span>${escape(label)}</span></div>`;
  const method=text=>`<details class="story-method"><summary>How to read this</summary><p>${text}</p></details>`;
  const riderButton=r=>`<button type="button" class="text-link-btn" data-story-rider="${Number(r.rider_key)}" data-story-team="${Number(r.team_key)}">Rider results ↗</button>`;
  const option=(v,label,selected)=>`<option value="${escape(v)}" ${same(v,selected)?'selected':''}>${escape(label)}</option>`;
  const select=(id,label,options)=>`<label class="story-select" for="${id}"><span>${label}</span><select id="${id}" class="control-select">${options}</select></label>`;
  function terrainModel(rows,standings=[],terrain='flat'){
    const groups=new Map();
    rows.forEach(r=>{if(!groups.has(r.rider_key))groups.set(r.rider_key,{...r,cells:{},rank:standings.find(s=>same(s.rider_key,r.rider_key))?.rank});groups.get(r.rider_key).cells[r.stage_type]=r;});
    const riders=[...groups.values()].sort((a,b)=>{
      const x=a.cells[terrain],y=b.cells[terrain];
      return Number(Boolean(y))-Number(Boolean(x))||(y?.win_count||0)-(x?.win_count||0)||(y?.top10_ratio||0)-(x?.top10_ratio||0)||(y?.sample_count||0)-(x?.sample_count||0)||String(a.rider_name).localeCompare(String(b.rider_name));
    });
    return {riders,terrains:terrains.filter(t=>rows.some(r=>r.stage_type===t))};
  }
  function teamContributions(rows,key){
    const map=new Map();rows.filter(r=>same(r.team_key,key)).forEach(r=>{if(!map.has(r.rider_key))map.set(r.rider_key,{...r,top10_count:0,win_count:0});const item=map.get(r.rider_key);item.top10_count+=Number(r.top10_count||0);item.win_count+=Number(r.win_count||0);});
    return [...map.values()].sort((a,b)=>b.top10_count-a.top10_count||b.win_count-a.win_count||a.rider_key-b.rider_key);
  }
  function gapModel(rows,keys){
    const selected=rows.filter(r=>keys.some(k=>same(k,r.rider_key)));
    const ids=[...new Set(selected.map(r=>r.stage_id))].sort((a,b)=>a-b);
    const stages=ids.map(id=>{const rr=selected.filter(r=>r.stage_id===id),valid=rr.filter(r=>has(r.stage_net_change_seconds));const complete=keys.length>=2&&new Set(valid.map(r=>r.rider_key)).size===keys.length;return {stage_id:id,stage_type:rr[0]?.stage_type,rows:rr,spread:complete?Math.max(...valid.map(r=>Number(r.stage_net_change_seconds)))-Math.min(...valid.map(r=>Number(r.stage_net_change_seconds))):null};});
    const ranked=stages.filter(s=>has(s.spread)).sort((a,b)=>b.spread-a.spread||a.stage_id-b.stage_id);
    return {stages,peak:ranked[0]||null,rows:selected};
  }
  async function load(mod,filters,post){
    const jobs=[post(`/api/analytics/${mod}`,filters)];
    if(mod==='rider_specialisation')jobs.push(post('/api/analytics/rider_standings',{...filters,classification:'gc'}));
    if(mod==='team_depth')jobs.push(post('/api/analytics/rider_specialisation',filters));
    const results=await Promise.all(jobs);
    return {rows:results[0].rows||[],standings:mod==='rider_specialisation'?results[1].rows||[]:[],specialisation:mod==='team_depth'?results[1].rows||[]:[]};
  }
  function renderTerrain(data,filters,prefs){
    if(!data.rows.length)return empty();
    const available=terrains.filter(t=>data.rows.some(r=>r.stage_type===t));
    const terrain=available.includes(prefs.terrain)?prefs.terrain:available[0];prefs.terrain=terrain;
    const model=terrainModel(data.rows,data.standings,terrain);
    const rider=model.riders.find(r=>same(r.rider_key,prefs.rider))||model.riders[0];prefs.rider=rider.rider_key;
    const shown=model.riders.slice(0,12);if(!shown.some(r=>r.rider_key===rider.rider_key))shown[shown.length-1]=rider;
    const cell=rider.cells[terrain], rankLabel=filters.rank_scope==='filtered'?'Subgroup time rank':filters.stage_scope==='selection'?'Selected-stage rank':filters.stage_scope==='as_of'?'GC at cutoff':'Final GC rank';
    const headline=cell?`<span>${escape(rider.rider_name)}</span><br><strong>${num(cell.win_count)}</strong> ${escape(labels[terrain].toLowerCase())} ${cell.win_count===1?'win':'wins'}<span class="story-headline-divider"> / </span><strong class="teal">${num(cell.top10_count)}</strong> top-10 finishes`:`<span>${escape(rider.rider_name)}</span><br>No ${escape(labels[terrain].toLowerCase())} results in scope`;
    return `<div class="story-lead"><div class="story-headline">${headline}</div><div class="story-lead-metrics">${metric(rankLabel,rider.rank==null?'—':`#${rider.rank}`)}${metric('Completed '+labels[terrain].toLowerCase()+' stages',cell?.sample_count??'—')}</div></div>
    <div class="story-toolbar">${select('story-terrain','Compare Stage Type',available.map(t=>option(t,labels[t],terrain)).join(''))}<span>Top-10 finish rate <i class="heat-scale" aria-hidden="true"></i> 0–100%</span></div>
    <div class="story-split terrain-split"><div class="story-chart-panel"><div class="heat-scroll"><table class="terrain-heatmap"><thead><tr><th scope="col">Rider</th>${model.terrains.map(t=>`<th scope="col">${escape(labels[t])}</th>`).join('')}</tr></thead><tbody>${shown.map(r=>`<tr class="${r.rider_key===rider.rider_key?'selected':''}"><th scope="row"><button type="button" data-story-select-rider="${r.rider_key}" aria-pressed="${r.rider_key===rider.rider_key}">${escape(r.rider_name)}</button><small>${escape(short(r.team_name))}</small></th>${model.terrains.map(t=>{const c=r.cells[t],p=c?.top10_ratio;return `<td>${c?`<button type="button" class="heat-cell ${Number(p)>=.95?'heat-dark':''}" style="--heat:${has(p)?Math.max(0,Math.min(1,Number(p))):0}" data-story-select-rider="${r.rider_key}" data-story-terrain="${escape(t)}" aria-label="${escape(r.rider_name)}, ${escape(labels[t])}: ${percent(p)} top 10, ${num(c.win_count)} wins in ${num(c.sample_count)} completed stages"><b>${percent(p)}</b><small>n=${num(c.sample_count)}${Number(c.win_count)>0?` · ${num(c.win_count)}W`:''}</small></button>`:'<span class="heat-missing" aria-label="No completed stages">—</span>'}</td>`;}).join('')}</tr>`).join('')}</tbody></table></div><p class="story-caption">${Math.min(12,model.riders.length)} of ${model.riders.length} riders · ordered by ${escape(labels[terrain].toLowerCase())} wins, then top-10 rate${shown[shown.length-1]===rider&&model.riders.indexOf(rider)>=12?' · selected rider included':''}</p></div>
    <aside class="story-detail"><div class="story-detail-title">${escape(rider.rider_name)}</div><p>${escape(short(rider.team_name))}</p><div class="terrain-profile">${model.terrains.map(t=>{const c=rider.cells[t];return `<div><span>${escape(labels[t])}</span><strong>${percent(c?.top10_ratio)}</strong><div class="story-track"><i style="width:${100*(Number(c?.top10_ratio)||0)}%"></i></div><small>${c?`${num(c.top10_count)} top 10 / ${num(c.sample_count)} completed stages`:'No completed stages'}</small></div>`;}).join('')}</div>${riderButton(rider)}</aside></div>
    <div class="story-takeaway"><strong>Build a role-specific shortlist.</strong><span>Use stage-specific results alongside GC when building a shortlist; race roles also shape finishing positions.</span></div>
    ${method('Cells use recorded finish ranks, regardless of the time basis. W = wins; n = completed stages. Missing stage type results are shown as —, not zero. The time ranking follows the active scope, time basis and ranking cohort; — means no eligible standing. No salary or contract data is available to assess cost efficiency.')}`;
  }
  function scatter(rows,a,b){
    const w=720,h=315,left=50,right=660,top=32,bottom=266,maxWins=Math.max(1,...rows.map(r=>Number(r.wins)||0));
    const valid=rows.filter(r=>has(r.top10_stage_coverage)&&has(r.wins));
    const axis=[0,.25,.5,.75,1].map(x=>`<line x1="${left+x*(right-left)}" x2="${left+x*(right-left)}" y1="${top}" y2="${bottom}" class="story-grid"/><text x="${left+x*(right-left)}" y="288" text-anchor="middle">${x*100}%</text>`).join('');
    const ys=[...new Set([0,Math.ceil(maxWins/2),maxWins])].map(n=>`<line x1="${left}" x2="${right}" y1="${bottom-n/maxWins*(bottom-top)}" y2="${bottom-n/maxWins*(bottom-top)}" class="story-grid"/><text x="35" y="${bottom-n/maxWins*(bottom-top)+4}" text-anchor="end">${n}</text>`).join('');
    const sorted=[...valid].sort((x,y)=>Number(same(x.team_key,a)||same(x.team_key,b))-Number(same(y.team_key,a)||same(y.team_key,b)));
    const dots=sorted.map(r=>{const x=left+Number(r.top10_stage_coverage)*(right-left),y=bottom-Number(r.wins)/maxWins*(bottom-top),selected=same(r.team_key,a),other=same(r.team_key,b);const title=`${r.team_name}: ${r.wins} wins; ${percent(r.top10_stage_coverage)} stage coverage; ${r.top10_distinct_riders} contributors`;return `<g role="button" tabindex="0" data-story-select-team="${r.team_key}" aria-label="${escape(title)}"><title>${escape(title)}</title><circle cx="${x}" cy="${y}" r="${5+Math.sqrt(Number(r.top10_distinct_riders)||0)*4}" fill="${selected?'#087e79':other?'#ba632b':'#b8c9d3'}" fill-opacity="${selected||other?'.85':'.55'}" stroke="${selected||other?'#fff':'#7b98a9'}" stroke-width="2"/>${selected||other?`<text x="${Math.min(right-90,Math.max(left+65,x))}" y="${Math.max(18,y-22)}" text-anchor="middle" class="story-dot-label">${escape(short(r.team_name).slice(0,25))}</text>`:''}</g>`;}).join('');
    return `<svg viewBox="0 0 ${w} ${h}" role="group" aria-label="Team wins versus top-10 stage coverage; bubble size represents contributors"><text x="10" y="16">Wins</text>${axis}${ys}${dots}<text x="355" y="311" text-anchor="middle">Stages with a top-10 finish</text></svg>`;
  }
  function renderTeams(data,filters,prefs){
    const rows=data.rows;if(!rows.length)return empty();
    const byWins=[...rows].sort((a,b)=>b.wins-a.wins||Number(b.top10_stage_coverage)-Number(a.top10_stage_coverage));
    const a=rows.find(r=>same(r.team_key,prefs.team))||byWins[0];prefs.team=a.team_key;
    const b=rows.find(r=>same(r.team_key,prefs.compare)&&!same(r.team_key,a.team_key))||[...rows].filter(r=>!same(r.team_key,a.team_key)).sort((x,y)=>Number(y.top10_stage_coverage)-Number(x.top10_stage_coverage))[0];prefs.compare=b?.team_key;
    const panel=(r,tone)=>`<article class="team-comparison ${tone}"><span class="team-color" aria-hidden="true"></span><strong>${escape(short(r.team_name))}</strong><div class="team-measures">${metric('Stage wins',num(r.wins),tone)}${metric('Top-10 stage coverage',percent(r.top10_stage_coverage),tone)}${metric('Top-10 contributors',num(r.top10_distinct_riders),tone)}</div><div class="coverage-strip" role="img" aria-label="${r.top10_stages} of ${r.selected_stage_count} stages with a top-10 finish">${Array.from({length:Number(r.selected_stage_count)||0},(_,n)=>`<i class="${n<Number(r.top10_stages)?'filled':''}"></i>`).join('')}</div><small>${num(r.top10_stages)} of ${num(r.selected_stage_count)} stages</small><button type="button" class="text-link-btn" data-story-roster="${r.team_key}">Team roster ↗</button></article>`;
    const riders=teamContributions(data.specialisation,a.team_key).filter(r=>r.top10_count>0),max=Math.max(1,...riders.map(r=>r.top10_count));
    return `<div class="team-compare-grid">${panel(a,'teal')}${b?panel(b,'amber'):'<div class="story-single">One team in this scope.</div>'}</div>
    <div class="story-toolbar">${select('story-team','Team',rows.map(r=>option(r.team_key,short(r.team_name),a.team_key)).join(''))}${b?select('story-compare','Compare with',rows.filter(r=>r.team_key!==a.team_key).map(r=>option(r.team_key,short(r.team_name),b.team_key)).join('')):''}</div>
    <div class="story-split team-split"><div class="story-chart-panel">${scatter(rows,a.team_key,b?.team_key)}<p class="story-caption">${rows.length} teams · bubble size: riders contributing top-10 finishes</p></div><aside class="story-detail"><div class="story-detail-title">Who contributes?</div><p>${escape(short(a.team_name))} · top-10 finishes</p><div class="contribution-bars">${riders.map(r=>`<button type="button" data-story-rider="${r.rider_key}" data-story-team="${a.team_key}" aria-label="${escape(r.rider_name)}: ${r.top10_count} top-10 finishes, ${r.win_count} wins; view rider results"><span>${escape(r.rider_name)}<small> · ${r.win_count}W</small></span><b>${r.top10_count}</b><i style="width:${100*r.top10_count/max}%"></i></button>`).join('')||'<p>No top-10 finishes in scope.</p>'}</div><p class="story-caption">${Math.max(0,Number(a.participants||0)-riders.length)} riders without a top-10 finish · W = wins</p></aside></div>
    <div class="story-takeaway"><strong>Balance wins with coverage.</strong><span>Compare peak results with the breadth of contributors when planning a squad. Sponsors can use this distinction to frame sporting objectives.</span></div>
    ${method('Stage coverage = selected stages with at least one top-10 finish ÷ selected stages. Contributors are distinct riders with a top-10 finish. All counts follow the rider, team, age and stage filters and use recorded finish ranks; the time basis does not rerank them. The coverage strip shows a count, not the stage sequence. Sporting results do not measure media exposure or sponsorship return.')}`;
  }
  function evolutionSeries(rows){
    const map=new Map();rows.forEach(r=>{if(!map.has(r.rider_key))map.set(r.rider_key,{...r,points:[]});map.get(r.rider_key).points.push(r);});
    const series=[...map.values()];series.forEach(s=>{s.points.sort((a,b)=>a.stage_order-b.stage_order);s.last=s.points[s.points.length-1];});
    return series.sort((a,b)=>b.last.stage_order-a.last.stage_order||(a.last.cumulative_rank??Infinity)-(b.last.cumulative_rank??Infinity)||a.rider_key-b.rider_key);
  }
  function lineChart(series,stages){
    const left=48,right=700,top=20,bottom=205,max=Math.max(60,...series.flatMap(s=>s.points.filter(p=>has(p.cumulative_gap_seconds)).map(p=>Number(p.cumulative_gap_seconds))));
    const xmin=stages[0].stage_id,xmax=stages[stages.length-1].stage_id,xx=id=>left+(id-xmin)/Math.max(1,xmax-xmin)*(right-left),yy=n=>bottom-Number(n)/max*(bottom-top);
    const grid=[0,.5,1].map(f=>`<line x1="${left}" x2="${right}" y1="${yy(max*f)}" y2="${yy(max*f)}" class="story-grid"/><text x="38" y="${yy(max*f)+4}" text-anchor="end">${time(max*f)}</text>`).join('');
    const ticks=stages.filter((s,i)=>i%Math.max(1,Math.ceil(stages.length/11))===0||i===stages.length-1).map(s=>`<text x="${xx(s.stage_id)}" y="228" text-anchor="middle">S${s.stage_id}</text>`).join('');
    const lines=series.map((s,i)=>{let segments=[],segment=[],prior=null;s.points.forEach(p=>{if(!has(p.cumulative_gap_seconds)||prior!==null&&Number(p.stage_order)!==prior+1){if(segment.length)segments.push(segment);segment=[];}if(has(p.cumulative_gap_seconds))segment.push(p);prior=Number(p.stage_order);});if(segment.length)segments.push(segment);return segments.map(ss=>`<path d="M${ss.map(p=>`${xx(p.stage_id)},${yy(p.cumulative_gap_seconds)}`).join(' L')}" fill="none" stroke="${colors[i]}" stroke-width="${i===0?3:2}"/>`).join('')+s.points.filter(p=>has(p.cumulative_gap_seconds)).map(p=>`<circle cx="${xx(p.stage_id)}" cy="${yy(p.cumulative_gap_seconds)}" r="3.5" fill="${colors[i]}"><title>${escape(s.rider_name)} · Stage ${p.stage_id} · +${time(p.cumulative_gap_seconds)}</title></circle>`).join('');}).join('');
    return `<svg viewBox="0 0 740 245" role="img" aria-label="Cumulative gaps to the leader in minutes and seconds; each colored line is a named rider">${grid}${ticks}${lines}</svg>`;
  }
  function renderEvolution(data,filters,prefs){
    if(!data.rows.length)return empty();
    const all=evolutionSeries(data.rows),focus=all.find(s=>same(s.rider_key,prefs.focus))||all[0];prefs.focus=focus.rider_key;
    const series=[focus,...all.filter(s=>s.rider_key!==focus.rider_key).slice(0,4)];
    const model=gapModel(data.rows,series.map(s=>s.rider_key));
    const selected=model.stages.find(s=>same(s.stage_id,prefs.stage))||model.peak||model.stages[0];prefs.stage=selected.stage_id;
    const max=Math.max(1,...model.stages.filter(s=>has(s.spread)).map(s=>s.spread));
    const deltas=series.map(s=>({rider:s,row:selected.rows.find(r=>r.rider_key===s.rider_key)})),maxDelta=Math.max(1,...deltas.map(d=>Math.abs(Number(d.row?.stage_net_change_seconds)||0)));
    const scope=Array.isArray(filters.team_keys)||Array.isArray(filters.rider_keys)?`${series.length} of ${all.length} riders in the selected cohort`:`${filters.young_only?'Young rider ':''}final-race top ${all.length} · retrospective cohort`;
    return `<div class="story-lead"><div class="story-headline">${model.peak?`<span>Largest daily separation · ${escape(labels[model.peak.stage_type]||model.peak.stage_type)}</span><br>Stage <strong>${model.peak.stage_id}</strong><span class="story-headline-divider"> / </span><strong class="teal">${time(model.peak.spread)}</strong><small> min:sec</small>`:'<span>Selected rider trajectory</span><br>Follow the changing gap'}</div><div class="story-lead-metrics">${metric('Plotted riders',series.length)}${metric('Visible stages',model.stages.length)}</div></div>
    <div class="story-toolbar">${select('story-focus','Focus rider',all.map(s=>option(s.rider_key,s.rider_name,focus.rider_key)).join(''))}<span>${escape(scope)}</span></div>
    <div class="story-chart-panel trajectory-panel"><div class="story-legend">${series.map((s,i)=>`<span><i style="background:${colors[i]}"></i>${escape(s.rider_name)}</span>`).join('')}</div>${lineChart(series,model.stages)}<p class="story-caption">Gap to the ${filters.rank_scope==='filtered'?'selected cohort':'race'} leader · ${filters.time_basis==='finish'?'finish':'adjusted'} time · lower is closer${filters.stage_scope==='selection'?' · cumulative from Stage 1, including earlier unselected stages':''}</p></div>
    <div class="story-split stage-split"><div class="story-chart-panel"><div class="story-panel-heading">Where the gaps changed</div><div class="stage-spread" role="group" aria-label="Daily separation between plotted riders">${model.stages.map(s=>`<button type="button" data-story-stage="${s.stage_id}" class="${s.stage_id===selected.stage_id?'selected':''}" aria-pressed="${s.stage_id===selected.stage_id}" aria-label="Stage ${s.stage_id}: ${has(s.spread)?`${s.spread} seconds separation`:'insufficient shared results'}"><b>${has(s.spread)?time(s.spread):'—'}</b><span><i style="height:${has(s.spread)?Math.max(2,100*s.spread/max):0}%"></i></span><small>${s.stage_id}</small></button>`).join('')}</div><p class="story-caption">Stage · range of daily gap changes across all ${series.length} plotted riders</p></div>
    <aside class="story-detail"><div class="story-detail-title">Stage ${selected.stage_id} <span>${escape(labels[selected.stage_type]||'')}</span></div><p>Time gained (−) / lost (+) to the leader</p><div class="delta-bars">${deltas.map((d,i)=>{const delta=d.row?.stage_net_change_seconds;return `<div><span>${escape(d.rider.rider_name)}</span><b class="${Number(delta)<0?'teal':Number(delta)>0?'amber':''}">${has(delta)?`${Number(delta)>0?'+':Number(delta)<0?'−':''}${time(delta)}`:'—'}</b><div class="delta-track"><i style="left:${Number(delta)<0?50-50*Math.abs(delta)/maxDelta:50}%;width:${has(delta)?50*Math.abs(delta)/maxDelta:0}%;background:${colors[i]}"></i></div></div>`;}).join('')}</div><button type="button" class="text-link-btn" data-story-open-stage="${selected.stage_id}">Stage results ↗</button></aside></div>
    <div class="story-takeaway"><strong>Prioritise the race review.</strong><span>Start with stages that separated these riders, then inspect individual results to inform training and race preparation.</span></div>
    ${method('Daily separation is the largest minus the smallest change in cumulative gap among the plotted riders, not the gap to the stage winner. It is only calculated when at least two plotted riders all have results that day; — means insufficient shared results. The focus rider is shown with up to four others, ordered by their latest visible stage and cumulative rank. Changing the focus can change the comparison group. Cumulative gaps always include stages 1–S; the leader may change. This is retrospective evidence, not a prediction or proof of causality.')}`;
  }
  function mount({element,module,data,filters,preferences={},onRider,onTeam,onStage}){
    const draw=()=>{const active=element.ownerDocument?.activeElement;const focused=active&&element.contains(active)?active.id:null;
      element.innerHTML=module==='rider_specialisation'?renderTerrain(data,filters,preferences):module==='team_depth'?renderTeams(data,filters,preferences):renderEvolution(data,filters,preferences);
      if(focused)element.querySelector(`#${focused}`)?.focus({preventScroll:true});
    };
    const action=e=>{const t=e.target.closest('button,[data-story-select-team]');if(!t||!element.contains(t))return;if(e.type==='keydown'){if(t.tagName.toLowerCase()==='button'||!['Enter',' '].includes(e.key))return;e.preventDefault();}
      const d=t.dataset;
      if(d.storyRider!==undefined){onRider(Number(d.storyRider),Number(d.storyTeam));return;}
      if(d.storyRoster!==undefined){onTeam(Number(d.storyRoster));return;}
      if(d.storyOpenStage!==undefined){onStage(Number(d.storyOpenStage));return;}
      let focus=null;
      if(d.storySelectRider!==undefined){preferences.rider=Number(d.storySelectRider);if(d.storyTerrain)preferences.terrain=d.storyTerrain;focus=`[data-story-select-rider="${d.storySelectRider}"]`;}
      if(d.storySelectTeam!==undefined){preferences.team=Number(d.storySelectTeam);focus=`[data-story-select-team="${d.storySelectTeam}"]`;}
      if(d.storyStage!==undefined){preferences.stage=Number(d.storyStage);focus=`[data-story-stage="${d.storyStage}"]`;}
      if(focus){draw();element.querySelector(focus)?.focus({preventScroll:true});}
    };
    element.onclick=action;element.onkeydown=action;
    element.onchange=e=>{const id=e.target.id,v=e.target.value;if(id==='story-terrain'){preferences.terrain=v;delete preferences.rider;}if(id==='story-team')preferences.team=Number(v);if(id==='story-compare')preferences.compare=Number(v);if(id==='story-focus'){preferences.focus=Number(v);delete preferences.stage;}draw();};
    draw();
  }
  const api={terrainModel,teamContributions,gapModel,percent,load,renderTerrain,renderTeams,renderEvolution,mount};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RaceInsights=api;
})(typeof window!=='undefined'?window:globalThis);

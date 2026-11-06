/* Dimension navigation over existing analytical API results. No ranking/scoring
   algorithm lives here: team standings and recorded finish ranks are server-owned.
   Counts/distances use dimension grain; available-stage rider times use result grain. */
(function(root){
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const terrainLabel = value => ({flat:'Flat',hilly:'Hilly',mountain:'Mountain','individual time-trial':'Time trial'}[value] || value);
  const same = (a,b) => String(a)===String(b);
  const includes = (filter,value) => !Array.isArray(filter)||filter.some(x=>same(x,value));
  const total = (rows,key) => !rows.length || rows.some(r=>r[key]==null) ? null : rows.reduce((sum,r)=>sum+Number(r[key]),0);
  const unique = (rows,key) => new Set(rows.map(r=>r[key])).size;
  const duration = seconds => seconds==null?'—':`${Math.floor(seconds/3600)}:${String(Math.floor(seconds%3600/60)).padStart(2,'0')}:${String(Math.round(seconds%60)).padStart(2,'0')}`;
  const levelsFor = (dimension,role) => dimension==='terrain'?['terrain','stage','riderResult']:dimension==='country'?(role==='nationality'?['country','rider','stageResult']:['country','team','rider','stageResult']):['team','rider','stageResult'];
  const levelLabels={country:'Countries',team:'Teams',rider:'Riders',terrain:'Terrain types',stage:'Stages',riderResult:'Rider results',stageResult:'Stage results'};
  function createModel({metadata,filters={},results=[],standings=[]}){
    const riders=(metadata.riders||[]).filter(r=>includes(filters.team_keys,r.team_key)&&includes(filters.rider_keys,r.rider_key)&&(!filters.young_only||r.is_young_rider));
    const stages=(metadata.stages||[]).filter(s=>filters.stage_scope==='as_of'?Number(s.stage_order||s.stage_id)<=Number(filters.as_of_stage||21):filters.stage_scope==='selection'?includes(filters.stage_ids,s.stage_id)&&includes(filters.stage_types,s.stage_type):true);
    const riderSet=new Set(riders.map(r=>r.rider_key)), stageSet=new Set(stages.map(s=>s.stage_id));
    return {filters,riders,stages,teams:(metadata.teams||[]).filter(t=>riders.some(r=>r.team_key===t.team_key)),countries:(metadata.countries||[]).filter(c=>c.country_code!=='UNK'),results:results.filter(r=>riderSet.has(r.rider_key)&&stageSet.has(r.stage_id)),standings};
  }
  function scopeAt(model,dimension,role,path){
    const levels=levelsFor(dimension,role);
    let riders=model.riders, stages=model.stages, teams=model.teams;
    if(dimension==='country'&&role==='nationality') riders=riders.filter(r=>r.rider_country_code&&r.rider_country_code!=='UNK');
    path.forEach((value,i)=>{
      if(levels[i]==='country'){
        if(role==='nationality') riders=riders.filter(r=>same(r.rider_country_code,value));
        else {teams=teams.filter(t=>same(t.team_country_code,value));riders=riders.filter(r=>teams.some(t=>t.team_key===r.team_key));}
      }
      if(levels[i]==='team') riders=riders.filter(r=>same(r.team_key,value));
      if(levels[i]==='rider') riders=riders.filter(r=>same(r.rider_key,value));
      if(levels[i]==='terrain') stages=stages.filter(s=>same(s.stage_type,value));
      if(levels[i]==='stage') stages=stages.filter(s=>same(s.stage_id,value));
    });
    teams=teams.filter(t=>riders.some(r=>r.team_key===t.team_key));
    const riderKeys=new Set(riders.map(r=>r.rider_key)),stageIds=new Set(stages.map(s=>s.stage_id));
    const facts=model.results.filter(r=>riderKeys.has(r.rider_key)&&stageIds.has(r.stage_id));
    return {riders,stages,teams,facts};
  }
  function getView(model,dimension='team',role='registration',path=[]){
    const levels=levelsFor(dimension,role),level=levels[Math.min(path.length,levels.length-1)];
    const {riders,stages,teams,facts}=scopeAt(model,dimension,role,path);
    const timeKey=model.filters.time_basis==='finish'?'finish_time_seconds':'adjusted_time_seconds';
    const byRider=key=>facts.filter(f=>same(f.rider_key,key));
    const byTeam=key=>facts.filter(f=>same(f.team_key,key));
    const stat=fs=>({completed:fs.length,stage_count:unique(fs,'stage_id'),selected_seconds:total(fs,timeKey)});
    let rows=[];
    if(level==='team') rows=teams.map(t=>{const standing=model.standings.find(s=>s.team_key===t.team_key)||{};return {key:String(t.team_key),label:t.team_name,country:t.team_country_code,rider_count:riders.filter(r=>r.team_key===t.team_key).length,...stat(byTeam(t.team_key)),rank:standing.rank,total_seconds:standing.total_seconds};}).sort((a,b)=>(a.rank??Infinity)-(b.rank??Infinity)||a.label.localeCompare(b.label));
    if(level==='rider') rows=riders.map(r=>({key:String(r.rider_key),label:`#${r.bib_number} ${r.rider_name}`,subtitle:teams.find(t=>t.team_key===r.team_key)?.team_name||'',country:r.rider_country_code||'UNK',status:r.finished_race_flag===1?'Finished race':'Exited race',...stat(byRider(r.rider_key))})).sort((a,b)=>Number(a.key)-Number(b.key));
    if(level==='country') rows=model.countries.map(c=>{const ct=teams.filter(t=>t.team_country_code===c.country_code), cr=riders.filter(r=>role==='nationality'?r.rider_country_code===c.country_code:ct.some(t=>t.team_key===r.team_key)),keys=new Set(cr.map(r=>r.rider_key));return {key:c.country_code,label:c.country_name,subtitle:c.country_code,team_count:role==='nationality'?unique(cr,'team_key'):ct.length,rider_count:cr.length,...stat(facts.filter(f=>keys.has(f.rider_key)))};}).sort((a,b)=>b.rider_count-a.rider_count||a.label.localeCompare(b.label));
    if(level==='terrain') rows=[...new Set(stages.map(s=>s.stage_type))].map(type=>{const ss=stages.filter(s=>s.stage_type===type),ids=new Set(ss.map(s=>s.stage_id)),fs=facts.filter(f=>ids.has(f.stage_id));return {key:type,label:terrainLabel(type),stage_count:ss.length,distance:total(ss,'distance_km'),rider_count:unique(fs,'rider_key'),completed:fs.length};});
    if(level==='stage') rows=stages.map(s=>{const fs=facts.filter(f=>f.stage_id===s.stage_id);return {key:String(s.stage_id),label:`Stage ${s.stage_id}`,subtitle:s.route_description||s.stage_name||'',date:s.stage_date,distance:s.distance_km,completed:fs.length};}).sort((a,b)=>Number(a.key)-Number(b.key));
    if(level==='stageResult'||level==='riderResult') rows=facts.map(f=>({key:level==='stageResult'?String(f.stage_id):String(f.rider_key),label:level==='stageResult'?`Stage ${f.stage_id}`:`#${f.bib_number} ${f.rider_name}`,subtitle:level==='stageResult'?(stages.find(s=>s.stage_id===f.stage_id)?.route_description||terrainLabel(f.stage_type)):f.team_name,terrain:terrainLabel(f.stage_type),date:f.stage_date,finish_rank:f.finish_rank,selected_seconds:f[timeKey],bonus:f.time_bonus_seconds,penalty:f.time_penalty_seconds})).sort((a,b)=>level==='stageResult'?Number(a.key)-Number(b.key):a.finish_rank-b.finish_rank||Number(a.key)-Number(b.key));
    const c=(key,label,format='number')=>({key,label,format});
    const columns={
      country:[c('label','Country','label'),c('team_count',role==='nationality'?'Teams represented':'Registered teams'),c('rider_count','Riders'),c('completed','Completed rides')],
      team:[c('label','Team','label'),c('country','Registration','text'),c('rider_count','Riders'),c('rank','Team rank'),c('total_seconds','Team time','duration'),c('completed','Completed rides')],
      rider:[c('label','Rider','label'),c('country','Nationality','text'),c('status','Race status','text'),c('stage_count','Stages completed'),c('selected_seconds','Available-stage time','duration')],
      terrain:[c('label','Terrain','label'),c('stage_count','Stages'),c('distance','Route km','decimal'),c('rider_count','Riders with results'),c('completed','Completed rides')],
      stage:[c('label','Stage / route','label'),c('date','Date','text'),c('distance','Route km','decimal'),c('completed','Riders with results')],
      stageResult:[c('label','Stage / route','label'),c('terrain','Terrain','text'),c('finish_rank','Finish rank'),c('selected_seconds',model.filters.time_basis==='finish'?'Finish time':'Adjusted time','duration'),c('bonus','Bonus (s)'),c('penalty','Penalty (s)')],
      riderResult:[c('label','Rider / team','label'),c('finish_rank','Finish rank'),c('selected_seconds',model.filters.time_basis==='finish'?'Finish time':'Adjusted time','duration'),c('bonus','Bonus (s)'),c('penalty','Penalty (s)')]
    }[level];
    const note=level==='team'?`Team time uses ${model.filters.team_aggregation==='cumulative_top3'?'cumulative top 3':'per-stage top 3'}. Ranks retain the global ranking cohort; — means no eligible team standing.`:level==='rider'?'Includes exited riders. Available-stage time is their contribution within this scope, not a GC ranking.':level==='country'?`${role==='nationality'?'Grouped by rider nationality; unknown nationality is excluded.':'Grouped by team registration country; all rider nationalities are included.'} Membership follows the rider/team filters; completed rides also follow stage scope.`:level==='terrain'||level==='stage'?'Route distance is counted once per stage. Completed rides count rider–stage results in the active cohort.':'Finish rank is the recorded stage placing; the time column follows your selected time basis. Rankings are not recalculated for a subgroup.';
    return {level,levels,title:levelLabels[level],leaf:path.length===levels.length-1,rows,columns,note,metrics:{riders:riders.length,completed:facts.length,distance:total(stages,'distance_km'),stages:stages.length}};
  }
  const measures = {
    top10: 'Top-ten finishes', teams:'Registered teams', roster: 'Roster size', wins: 'Stage wins', podiums: 'Podium finishes',
    time: 'Team & rider time', results: 'Completed rides', gap: 'Mean gap to stage winner'
  };
  const placings = {top10:10, podiums:3, wins:1};

  function mergeFilters(active, detail, stages) {
    const filters = {...active,...detail};
    for (const field of ['team_keys','rider_keys']) {
      if (Array.isArray(active[field]) && Array.isArray(detail[field]))
        filters[field] = active[field].filter(key=>detail[field].some(value=>same(key,value)));
    }
    if (active.young_only) filters.young_only = true;
    const permits = (s,f) =>
      (f.stage_scope !== 'as_of' || s.stage_id <= Number(f.as_of_stage || 21)) &&
      includes(f.stage_ids,s.stage_id) && includes(f.stage_types,s.stage_type);
    if (detail.stage_scope || detail.stage_ids || detail.stage_types) {
      filters.stage_scope = 'selection';
      filters.stage_ids = stages.filter(s=>permits(s,active)&&permits(s,detail)).map(s=>s.stage_id);
      delete filters.as_of_stage;
      delete filters.stage_types;
    }
    return filters;
  }

  function measureResult(scope,metric,dimension) {
    const facts=placings[metric] ? scope.facts.filter(f=>Number(f.finish_rank)<=placings[metric]) : scope.facts;
    let value=facts.length;
    if (metric==='teams') value=scope.teams.length;
    if (metric==='roster') value=dimension==='terrain'?unique(facts,'rider_key'):scope.riders.length;
    if (metric==='time') value=facts.reduce((n,f)=>n+Number(f.adjusted_time_seconds),0);
    if (metric==='gap') {
      const recorded = facts.filter(f=>f.gap_seconds != null);
      value = recorded.length ? recorded.reduce((sum,f)=>sum+Number(f.gap_seconds),0)/recorded.length : null;
    }
    return {value,facts};
  }

  function metricView(model,dimension,role,path,metric) {
    const base=getView(model,dimension,role,path);
    if (!metric) return base;
    if (metric==='teams' && base.level==='rider') metric='roster';
    if (metric==='teams' && base.leaf) metric='results';
    base.measureLabel = measures[metric];
    const scope=scopeAt(model,dimension,role,path);
    const {facts,value}=measureResult(scope,metric,dimension);
    const col=(key,label,format='number')=>({key,label,format});
    const unit=metric==='time'?'duration':metric==='gap'?'decimal':'number';
    if (base.leaf) {
      base.rows=facts.map(f=>({
        key:String(dimension==='terrain'?f.rider_key:f.stage_id),
        label:dimension==='terrain'?f.rider_name:'Stage '+f.stage_id,subtitle:dimension==='terrain'?f.team_name:f.stage_name,
        date:f.stage_date,rider:f.rider_name,team:f.team_name,terrain:terrainLabel(f.stage_type),stage_id:f.stage_id,
        finish_rank:f.finish_rank,distance:f.distance_km,raw:f.finish_time_seconds,adjusted:f.adjusted_time_seconds,
        winner_gap:f.gap_seconds,bonus:f.time_bonus_seconds,penalty:f.time_penalty_seconds
      })).sort((a,b)=>a.stage_id-b.stage_id||a.finish_rank-b.finish_rank);
      base.columns=[col('label',dimension==='terrain'?'Rider / team':'Stage / route','label'),
        col('date','Date','text'),col('terrain','Terrain','text'),col('finish_rank','Finish rank'),
        col('distance','Km','decimal'),col('raw','Finish time','duration'),col('adjusted','Adjusted time','duration'),
        col('winner_gap','Gap to stage winner (s)'),col('bonus','Bonus (s)'),col('penalty','Penalty (s)')];
      if(dimension!=='terrain')base.columns.splice(2,0,col('rider','Rider','text'),col('team','Team','text'));
    } else {
      base.rows = base.rows.map(row=>{
        const branch = scopeAt(model,dimension,role,[...path,row.key]);
        const m=measureResult(branch,metric,dimension);
        return {...row,measure:m.value,records:m.facts.length};
      });
      if (path.length && placings[metric]) base.rows = base.rows.filter(r=>r.records);
      base.rows.sort((a,b)=>a.measure==null?1:b.measure==null?-1:
        (metric==='gap'?a.measure-b.measure:b.measure-a.measure)||a.label.localeCompare(b.label));
      base.columns=[col('label',levelLabels[base.level],'label'),col('measure',measures[metric]+(metric==='gap'?' (s)':''),unit)];
      if(base.level==='rider')base.columns.push(col('country','Nationality','text'),col('status','Race status','text'));
      if(base.level==='team')base.columns.push(col('country','Registration','text'));
      if(base.level==='stage')base.columns.push(col('date','Date','text'),col('distance','Km','decimal'));
      if (metric==='time'||metric==='gap')base.columns.push(col('records','Rider–stage results'));
    }
    base.measureText = metric==='time'?duration(value):value==null?'—':Number(value).toLocaleString('en-GB',{maximumFractionDigits:1});
    base.metric = metric;
    base.note=({teams:'Distinct teams registered in the selected country.',roster:'Distinct entrants, including riders who withdrew.',time:'Sum of adjusted times across completed rider–stage results.',gap:'Average raw finish-time gap to the stage winner, in seconds.',wins:'Recorded stage rank 1.',podiums:'Recorded stage ranks 1–3.',top10:'One appearance per rider and stage with recorded rank 1–10.',results:'One result per rider per completed stage.'})[metric];
    return base;
  }


  function validPath(model,dimension,role,path){const valid=[];for(const key of path){const view=getView(model,dimension,role,valid);if(view.leaf||!view.rows.some(r=>r.key===String(key)))break;valid.push(String(key));}return valid;}
  function createNavigator({getMetadata,getFilters,apiPost,onChange,initialMetric=null}){
    const state={metric:initialMetric, sort:'metric', dimension:'team',role:'registration',path:[],query:'',page:1,pageSize:25,model:null,loading:false,error:'',notice:''};
    let sequence=0;
    const notify=()=>onChange(state);
    const view=()=>state.model?metricView(state.model,state.dimension,state.role,state.path,state.metric):null;
    const levels = new Map();
    function clearLocal(){state.query='';state.page=1;state.notice='';}
    async function load(){
      const request=++sequence,filters=structuredClone(getFilters());state.loading=true;state.error='';notify();
      try{
        const [metadata,result,standing]=await Promise.all([getMetadata(),apiPost('/api/analytics/rider_stage_results',filters),state.metric ? {rows:[]} : apiPost('/api/analytics/team_standings',filters)]);
        if(request!==sequence)return;
        if(!metadata.riders?.length||!metadata.stages?.length)throw Error('Race metadata is unavailable. Try again after the data service is ready.');
        state.model=createModel({metadata,filters,results:result.rows,standings:standing.rows});
        const next=validPath(state.model,state.dimension,state.role,state.path);
        state.notice=next.length<state.path.length?'The selected branch is outside this scope. Returned to the nearest available level.':'';
        state.path=next;state.page=1;
      }catch(error){if(request!==sequence)return;state.model=null;state.error=error.message||'Unable to load drill-down results.';}
      if(request===sequence){state.loading=false;notify();}
    }
    function enter(intent){
      state.dimension=intent.dimension || 'team';state.role=intent.role || 'registration';
      state.metric=measures[intent.metric]?intent.metric:'top10';
      state.path=(intent.path||[]).map(String);state.entryLabel=intent.label||'';
      levels.clear();clearLocal();
    }
    const positionKey=()=>JSON.stringify([state.dimension,state.role,state.metric,state.path]);
    function rememberLevel(){levels.set(positionKey(),{page:state.page,query:state.query,sort:state.sort});}
    function setMetric(value){if(!measures[value])return;state.metric=value;state.entryLabel='';clearLocal();notify();}
    function choose(key){const v=view();if(!v||v.leaf||!v.rows.some(r=>r.key===String(key)))return;rememberLevel();state.path.push(String(key));clearLocal();notify();}
    function up(index){if(index<0||index>state.path.length)return;state.path=state.path.slice(0,index);clearLocal();Object.assign(state,levels.get(positionKey())||{});notify();}
    function setDimension(value){if(!['team','terrain','country'].includes(value))return;state.dimension=value;if(state.metric==='teams' && value!=='country')state.metric='roster';state.path=[];state.entryLabel='';levels.clear();clearLocal();notify();}
    function setRole(value){if(!['registration','nationality'].includes(value))return;state.role=value;if(state.metric==='teams' && value!=='registration')state.metric='roster';state.path=[];state.entryLabel='';levels.clear();clearLocal();notify();}
    const visibleRows=(activeView=view())=>{
      const q=state.query.toLocaleLowerCase();
      const rows=(activeView?.rows||[]).filter(r=>[r.label,r.subtitle,r.country,r.team].some(t=>String(t||'').toLocaleLowerCase().includes(q)));
      return state.sort==='name'?rows.sort((a,b)=>a.label.localeCompare(b.label,undefined,{numeric:true})):rows;
    };
    function setSort(key){state.sort=key;state.page=1;notify();}
    function setQuery(value){state.query=value;state.page=1;notify();}
    function setPage(value){const max=Math.max(1,Math.ceil(visibleRows().length/state.pageSize));state.page=Math.max(1,Math.min(max,Number(value)||1));notify();}
    return {state,load,view,enter,setMetric,setSort,choose,up,setDimension,setRole,setQuery,setPage,visibleRows,reset:()=>up(0)};
  }
  function render(nav){
    const s=nav.state,v=nav.view();
    const choices=[['team','Team'],['terrain','Stage terrain'],['country','Country']];
    let html=`
    <div class="drill-dimensions" role="group" aria-label="Drill-down dimension">${choices.map(([key,title])=>`<button type="button" class="drill-dimension ${s.dimension===key?'selected':''}" data-dimension="${key}" aria-pressed="${s.dimension===key}"><strong>${title}</strong><span aria-hidden="true">↘</span></button>`).join('')}</div>
    ${s.dimension==='country'?`<div class="drill-role"><label for="drill-country-role">Country role</label><select id="drill-country-role" class="control-select"><option value="registration" ${s.role==='registration'?'selected':''}>Team registration country</option><option value="nationality" ${s.role==='nationality'?'selected':''}>Rider nationality</option></select></div>`:''}`;
    if(s.metric)html+=`<div class="drill-measure-select"><label for="drill-measure">Measure</label><select id="drill-measure" class="control-select">${Object.entries(measures).filter(([key])=>key!=='teams'||(s.dimension==='country' && s.role==='registration')).map(([key,label])=>`<option value="${key}" ${key===s.metric?'selected':''}>${label}</option>`).join('')}</select></div>`;
    if(s.loading)return html+'<div class="card drill-feedback" role="status"><p>Loading results…</p></div>';
    if(s.error)return html+`<div class="card drill-feedback state-warning" role="alert"><h3>Unable to load Drill Down</h3><p>${escape(s.error)}</p><button type="button" class="btn-primary btn-compact" data-drill-retry>Try again</button></div>`;
    if(!v)return html;
    const f=s.model.filters;
    const stageScope=f.stage_scope==='selection'
      ? (s.model.stages.length ? s.model.stages.map(stage=>'S'+stage.stage_id).join(', ') : 'No selected stages')
      : f.stage_scope==='as_of'?'Through stage '+f.as_of_stage:'Full race';
    const memberScope=[...(Array.isArray(f.team_keys)?s.model.teams.map(t=>t.team_name):[]),
      ...(Array.isArray(f.rider_keys)?s.model.riders.map(r=>r.rider_name):[])];
    const entry=[s.entryLabel,stageScope,...memberScope].filter(Boolean).join(' · ');
    html += '<p class="drill-entry-scope">'+escape(entry)+'</p>';
    html+=`<nav class="drill-journey" aria-label="Drill-down levels">${v.levels.map((level,i)=>{let detail=i===0?'All in scope':'';if(i>0&&i<=s.path.length){const prev=getView(s.model,s.dimension,s.role,s.path.slice(0,i-1));detail=prev.rows.find(r=>r.key===s.path[i-1])?.label||s.path[i-1];}return `<button type="button" data-drill-level="${i}" class="hierarchy-step ${i===s.path.length?'current':i<s.path.length?'visited':''}" ${i>s.path.length?'disabled':''} ${i===s.path.length?'aria-current="step"':''}><span class="hierarchy-step-number">${String(i+1).padStart(2,'0')}</span><span><strong>${levelLabels[level]}</strong>${detail?`<small title="${escape(detail)}">${escape(detail)}</small>`:''}</span><span class="hierarchy-step-arrow" aria-hidden="true">→</span></button>`;}).join('')}</nav>`;
    if(s.notice)html+=`<p class="drill-notice" role="status">${escape(s.notice)}</p>`;
    const matched=nav.visibleRows(v),pages=Math.max(1,Math.ceil(matched.length/s.pageSize)),page=Math.min(s.page,pages),start=(page-1)*s.pageSize,shown=matched.slice(start,start+s.pageSize);
    const cells=(row,col)=>{const value=row[col.key];if(col.format==='label')return `<${v.leaf?'span':'button type="button"'} class="drill-row-label" ${v.leaf?'':`data-drill-choose="${escape(row.key)}"`}><strong>${escape(value)}</strong>${row.subtitle?`<small>${escape(row.subtitle)}</small>`:''}</${v.leaf?'span':'button'}>`;if(col.format==='duration')return duration(value);if(value==null)return '—';return escape(col.format==='decimal'?Number(value).toLocaleString('en-GB',{maximumFractionDigits:1}):col.format==='number'?Number(value).toLocaleString('en-GB'):value);};
    html+=`<section class="card drill-results" aria-labelledby="drill-level-heading"><div class="drill-results-header"><div><span class="card-kicker">LEVEL ${s.path.length+1} OF ${v.levels.length} </span><h3 id="drill-level-heading" tabindex="-1">${v.title}<span>${v.rows.length}</span></h3></div><div class="drill-navigation"><button type="button" class="btn-secondary btn-compact" data-drill-up ${s.path.length?'':'disabled'}>← Up one level</button><button type="button" class="text-link-btn" data-drill-reset ${s.path.length?'':'disabled'}>Reset path</button></div></div>
    <div class="drill-context">${s.metric?`<span class="drill-selected-measure">${escape(v.measureLabel||measures[s.metric])} · ${escape(v.measureText)}${s.metric==='gap'?' s':''}</span>`:''}${v.level==='rider'?'':`<span><b>${v.metrics.riders}</b> riders</span>`}<span><b>${v.metrics.stages}</b> stages in scope</span>${v.metric==='results'?'':`<span><b>${v.metrics.completed.toLocaleString('en-GB')}</b> completed rides</span>`}</div>
    <details class="drill-measure-details"><summary>Measure definitions</summary><p class="drill-measure-note">${escape(v.note)}</p></details>
    <div class="drill-table-tools"><label class="drill-search-label" for="drill-search">Find in this level</label><input type="search" id="drill-search" class="control-select drill-search" placeholder="Search ${v.title.toLowerCase()}…" value="${escape(s.query)}"/><label for="drill-sort">Order</label><select id="drill-sort" class="control-select"><option value="metric">Measure / stage order</option><option value="name" ${s.sort==='name'?'selected':''}>Name</option></select></div>
    <div class="drill-grid-scroll" tabindex="0" aria-label="${escape(v.title)} results; scroll horizontally for all columns"><table class="data-table"><thead><tr>${v.columns.map(c=>`<th scope="col" class="${c.format==='number'||c.format==='decimal'||c.format==='duration'?'num-col':''}">${escape(c.label)}</th>`).join('')}${v.leaf?'':'<th scope="col"><span class="sr-only">Next level</span></th>'}</tr></thead><tbody>${shown.map(r=>`<tr ${v.leaf?'':`data-drill-choose="${escape(r.key)}" class="drill-selectable"`}>${v.columns.map(c=>`<td class="${['number','decimal','duration'].includes(c.format)?'num-col':''}">${cells(r,c)}</td>`).join('')}${v.leaf?'':'<td class="drill-row-arrow" aria-hidden="true">↘</td>'}</tr>`).join('')}</tbody></table>${!matched.length?`<div class="drill-empty"><h4>${s.query?'No matching rows':'No results at this level'}</h4><p>${s.query?'Try another search.':'Try a different branch or adjust the global filters.'}</p></div>`:''}</div>
    <div class="drill-pagination"><span>${matched.length?`${start+1}–${Math.min(start+s.pageSize,matched.length)}`:'0'} of ${matched.length} ${s.query?`matching · ${v.rows.length} total`:v.title.toLowerCase()}</span><div><button type="button" class="btn-secondary btn-compact" data-drill-page="${page-1}" ${page===1?'disabled':''}>Previous</button><span aria-live="polite">${page} / ${pages}</span><button type="button" class="btn-secondary btn-compact" data-drill-page="${page+1}" ${page===pages?'disabled':''}>Next</button></div></div></section>`;
    return html;
  }
  function mount({element,...options}){
    const nav=createNavigator({...options,onChange:()=>{
      const search=element.querySelector('#drill-search'),focused=search&&element.ownerDocument.activeElement===search,cursor=search?.selectionStart;
      element.innerHTML=render(nav);
      if(focused){const fresh=element.querySelector('#drill-search');fresh?.focus();if(fresh&&cursor!=null)fresh.setSelectionRange(cursor,cursor);}
    }});
    element.addEventListener('click',event=>{
      const target=event.target.closest('button,[data-drill-choose]');if(!target||target.disabled)return;
      const a=target.dataset;
      if(a.dimension){nav.setDimension(a.dimension);element.querySelector(`[data-dimension="${a.dimension}"]`)?.focus({preventScroll:true});}
      if(a.drillChoose!==undefined)nav.choose(a.drillChoose);
      if(a.drillLevel!==undefined)nav.up(Number(a.drillLevel));
      if(a.drillUp!==undefined)nav.up(nav.state.path.length-1);
      if(a.drillReset!==undefined)nav.reset();
      if(a.drillRetry!==undefined)nav.load();
      if(a.drillPage!==undefined)nav.setPage(Number(a.drillPage));
      if(a.drillChoose!==undefined||a.drillLevel!==undefined||a.drillUp!==undefined||a.drillPage!==undefined||a.drillReset!==undefined){const heading=element.querySelector('#drill-level-heading');heading?.focus({preventScroll:true});heading?.scrollIntoView({behavior:'smooth',block:'nearest'});}
    });
    element.addEventListener('input',event=>{if(event.target.id==='drill-search')nav.setQuery(event.target.value);});
    element.addEventListener('change',event=>{if(event.target.id==='drill-measure')nav.setMetric(event.target.value);if(event.target.id==='drill-sort')nav.setSort(event.target.value);if(event.target.id==='drill-country-role'){nav.setRole(event.target.value);element.querySelector('#drill-country-role')?.focus({preventScroll:true});}});
    return nav;
  }

  const api={createModel,getView,mergeFilters,metricView,validPath,escape,duration,levelsFor,levelLabels,createNavigator,render,mount};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RaceDrilldown=api;
})(typeof window!=='undefined'?window:globalThis);

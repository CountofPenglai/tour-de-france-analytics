// Exercise the actual page renderers and their drill actions through their shared context.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const window = {};
const script = fs.readFileSync(path.join(__dirname, '../web/static/team-pages.js'), 'utf8');
vm.runInNewContext(script, { window, Intl, console });

function fixture(rows) {
  const element = { innerHTML: '', querySelector() { return null; }, contains() { return true; } };
  const drills = [];
  const ctx = {
    element, filters: {stage_scope:'as_of', as_of_stage:12}, preferences:{}, isCurrent:() => true,
    metadata: {stages:[{stage_id:1,stage_order:1,stage_type:'flat'},{stage_id:11,stage_order:11,stage_type:'mountain'}]},
    report:async name => rows[name] || [], analytics:async name => rows[name] || [],
    drill:request => drills.push(JSON.parse(JSON.stringify(request)))
  };
  const click = (act, k, extra={}) => element.onclick({target:{closest:()=>({dataset:{act,k:String(k),...extra}})}});
  return {ctx,element,drills,click};
}

test('team depth opens its full roster including zero contributions and narrows rider evidence', async () => {
  const depth = {team_key:1,team_name:'Team Visma',participants:2,top10_distinct_riders:1,top10_finishes:2,top10_stages:2,selected_stage_count:2,wins:1};
  function rider(rider_key, rider_name, count) {
    return {team_key:1,team_name:'Team Visma',rider_key,rider_name,rider_country_name:'France',top10_count:count,win_count:0,completed_stage_count:2,rider_burden_seconds:300,terrain_top10:{flat:count}};
  }
  const {ctx,element,drills,click} = fixture({team_depth:[depth],team_roster_performance:[rider(11,'Scorer',2),rider(12,'Zero <Exit>',0)]});
  await window.RacePages.team_standings(ctx);
  assert.ok(element.innerHTML.indexOf('Top-10 riders') < element.innerHTML.indexOf('Team Standings'));
  assert.match(element.innerHTML,/Zero &lt;Exit&gt;/);
  click('contributors',1);
  assert.doesNotMatch(element.innerHTML.split('Top-10 finishes by terrain')[0],/Zero &lt;Exit&gt;/);
  click('roster',1);
  click('top-days',11);
  assert.deepEqual(drills[0].path,[1,11]);
  assert.equal(drills[0].metric,'top10');
});

test('mountain podiums, denominator and mean gap use their own evidence rows and keep the stage cutoff', async() => {
  const cells = ['mountain','flat'].map(stage_type=>({entity_kind:'rider',entity_key:11,entity_name:'Scorer',team_key:1,team_name:'Visma',stage_type,
    sample_count:2,podium_count:1,mean_winner_gap_seconds:9,speed_kmh:40,baseline_rank:1,mountain_rank:1,terrain_rank_gain:0}));
  const {ctx,click,drills} = fixture({terrain_performance:cells});
  await window.RacePages.rider_specialisation(ctx);
  click('mountain-days',11,{metric:'podiums'});
  click('mountain-days',11,{metric:'results'});
  click('mountain-days',11,{metric:'gap'});
  assert.deepEqual(drills.map(d=>d.metric),['podiums','results','gap']);
  for (const d of drills) {
    assert.deepEqual(d.path,[1,11]);
    assert.deepEqual(d.filters.stage_ids,[11]);
  }
});

test('empty and superseded requests do not resurrect a previous roster', async() => {
  const {ctx,element} = fixture({});
  await window.RacePages.team_standings(ctx);
  assert.match(element.innerHTML,/No .*scope/i);
  element.innerHTML = 'Other page';
  ctx.isCurrent = () => false;
  await window.RacePages.rider_specialisation(ctx);
  assert.equal(element.innerHTML,'Other page');
});

test('terrain evidence preserves an explicit empty stage scope instead of widening it', async() => {
  const cells = [{entity_kind:'rider',entity_name:'Rider',entity_key:11,team_key:2,team_name:'Test',stage_type:'mountain',
    speed_kmh:35,sample_count:1,podium_count:0,mean_winner_gap_seconds:20}];
  const {ctx,click,drills} = fixture({terrain_performance:cells});
  ctx.filters = {stage_scope:'selection',stage_ids:[]};
  await window.RacePages.rider_specialisation(ctx);
  click('mountain-days',11,{metric:'results'});
  assert.deepEqual(drills[0].filters.stage_ids,[]);
});

test('a late daily-time response cannot replace the currently selected team detail', async() => {
  const teams=[1,2].map(n=>({team_key:n,team_name:'Team '+n,participants:1,top10_distinct_riders:1,top10_finishes:1,top10_stages:1,selected_stage_count:1,wins:0}));
  const roster=teams.map(t=>({...t,rider_key:10*t.team_key,rider_name:'Rider '+t.team_key,completed_stage_count:1,top10_count:1,win_count:0,rider_burden_seconds:3599}));
  const {ctx,element,click} = fixture({team_depth:teams,team_roster_performance:roster});
  const orig=ctx.analytics, pending=new Map();
  ctx.analytics=(name,filters)=>name==='rider_stage_results' ? new Promise(resolve=>pending.set(filters.team_keys[0],resolve)) : orig(name,filters);
  await window.RacePages.team_standings(ctx);
  click('burden-team',1);
  click('burden-rider',10);
  click('burden-team',2);
  click('burden-rider',20);
  pending.get(2)([{rider_key:20,stage_id:2,stage_date:'day-two',adjusted_time_seconds:3599}]);
  await new Promise(resolve=>setImmediate(resolve));
  pending.get(1)([{rider_key:10,stage_id:1,stage_date:'stale-day-one',adjusted_time_seconds:3599}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(element.innerHTML,/day-two/);
  assert.doesNotMatch(element.innerHTML,/stale-day-one/);
});

test('team-level terrain evidence for an absent terrain keeps its empty stage selection', async () => {
  const row={team_key:1,team_name:'Team',participants:8,top10_distinct_riders:2,top10_finishes:2,top10_stages:1,selected_stage_count:1,wins:0};
  const {ctx,click,drills}=fixture({team_depth:[row]});
  ctx.filters={stage_scope:'selection',stage_ids:[1]};
  await window.RacePages.team_standings(ctx);
  click('terrain-days',1,{terrain:'mountain'});
  assert.deepEqual(drills[0].filters.stage_ids,[]);
  assert.deepEqual(drills[0].filters.stage_types,['mountain']);
  assert.deepEqual(drills[0].filters.team_keys,[1]);
});

test('terrain rank caption uses the SQL cohort and a filtered team dot opens all matching team rides', async () => {
  const rider = {entity_kind:'rider',entity_key:9,entity_name:'Jonas Vingegaard',team_key:18,team_name:'Team Visma',stage_type:'mountain',
    sample_count:6,podium_count:4,speed_kmh:37.6,mean_winner_gap_seconds:109,baseline_rank:9,mountain_rank:7,terrain_rank_gain:2,ranked_entities:172};
  const team = {...rider,entity_kind:'team',entity_key:18,entity_name:'Team Visma',sample_count:48,ranked_entities:23};
  const {ctx,element,click,drills} = fixture({terrain_performance:[rider,team]});
  let captured;
  ctx.filters={stage_scope:'as_of',as_of_stage:12,rank_scope:'overall',rider_keys:[9],young_only:true};
  ctx.analytics=async(name,filters)=>{captured=filters;return [{stage_id:11,stage_date:'2025-07-15',rider_name:'Teammate',stage_type:'mountain',distance_km:155,finish_rank:2,finish_time_seconds:5900,gap_seconds:5}];};
  await window.RacePages.rider_specialisation(ctx);
  assert.match(element.innerHTML,/172 riders/);
  element.onchange({type:'change',target:{closest:()=>({dataset:{act:'entity-kind'},value:'team'})}});
  assert.match(element.innerHTML,/23 teams/);
  click('profile-days',18,{terrain:'mountain'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(drills.length,0);
  assert.deepEqual(Array.from(captured.team_keys),[18]);
  assert.deepEqual(Array.from(captured.stage_ids),[11]);
  assert.equal(captured.rider_keys,undefined);
  assert.equal(captured.young_only,undefined);
  assert.match(element.innerHTML,/Teammate/);
});

test('an exited rider can identify a team with rides even when the rider has no completed stages', async () => {
  const team={entity_kind:'team',entity_key:18,entity_name:'Team Visma',team_key:18,team_name:'Team Visma',
    stage_type:'flat',speed_kmh:41,sample_count:7,ranked_entities:null};
  const {ctx,element}=fixture({terrain_performance:[team]});
  await window.RacePages.rider_specialisation(ctx);
  assert.match(element.innerHTML,/No riders completed/);
  element.onchange({type:'change',target:{closest:()=>({dataset:{act:'entity-kind'},value:'team'})}});
  assert.match(element.innerHTML,/Team Visma/);
});

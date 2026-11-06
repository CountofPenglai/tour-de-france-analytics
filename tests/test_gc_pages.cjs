const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const window = { RacePages: {} };
const source = path.join(__dirname, '../web/static/gc-pages.js');
if (fs.existsSync(source)) vm.runInNewContext(fs.readFileSync(source, 'utf8'), { window, console });

function context(overrides = {}) {
  return {
    element: { innerHTML: '', querySelector: () => null, contains: () => true },
    filters: {}, preferences: {}, metadata: { riders: [], stages: [], teams: [] },
    isCurrent: () => true, analytics: async () => [], report: async () => [],
    ...overrides
  };
}

test('an empty scope clears previous findings in all three pages', async () => {
  for (const name of ['rider_standings', 'gc_evolution', 'time_rules']) {
    assert.equal(typeof window.RacePages[name], 'function', name);
    const ctx = context({filters: { stage_scope: 'selection', stage_ids: [] }});
    ctx.element.innerHTML = 'Old findings';
    await window.RacePages[name](ctx);
    assert.doesNotMatch(ctx.element.innerHTML, /Old findings/);
    assert.match(ctx.element.innerHTML, /no .*(riders|results|stages)/i);
  }
});

test('navigation discards a pending response before its DOM changes', async () => {
  assert.equal(typeof window.RacePages.time_rules, 'function');
  let resolve, current = true;
  const ctx = context({isCurrent: () => current, report: () => new Promise(done => { resolve = done; })});
  const pending = window.RacePages.time_rules(ctx);
  current = false;
  ctx.element.innerHTML = 'Other page';
  resolve([]);
  await pending;
  assert.equal(ctx.element.innerHTML, 'Other page');
});

  function click(ctx, name, value) {
    const node = {dataset:{gcAction:name,value:String(value)}};
    return ctx.element.onclick({target:{closest:()=>node}});
  }
  function change(ctx, id, value, checked) {
    return ctx.element.onchange({target:{id,value,checked}});
  }
  const rider = {rider_key:16,bib_number:21,rider_name:'Ben O’Connor',team_key:2,team_name:'Team',
    age_at_race:29,age_group:'26-29',gc_rank:11,young_gc_rank:null,mountain_gc_rank:8,
    mountain_rank_gain:3,total_seconds:320000,gap_seconds:500,mountain_seconds:26000,mountain_stage_count:6};
  const stages = [11,12].map((id,i)=>({stage_id:id,stage_order:id,stage_date:`2025-07-${17+i}`,
    stage_type:i ? 'mountain' : 'flat',start_location_name:'A',finish_location_name:'B'}));
  function mark(r,s,now,prev,delta,secs) {
    return {...r,...s,cumulative_rank:now,previous_rank:prev,rank_gain:prev-now,
      daily_gap_change:delta,cumulative_seconds:secs,cumulative_gap_seconds:Math.max(0,delta),
      stage_seconds:14000,finish_rank:7,finish_time_seconds:14006,time_bonus_seconds:6,
      time_penalty_seconds:0,adjusted_time_seconds:14000};
  }

  test('a full classification link opens its rider, ties turning days and drills a single source row', async () => {
    let detail, selection;
    const rows = [mark(rider,stages[0],11,14,0,130000),mark(rider,stages[1],8,11,0,144000)];
    const ctx = context({filters:{stage_scope:'selection',stage_ids:[12]},
      preferences:{riderKey:16,finalGC:true,classification:'kom_proxy'},
      report:async(name,f)=>{ if(name==='gc_comparison') {selection=f; return [rider];} return rows; },
      analytics:async()=>[{...rider,rank:1,points:44}],drill:opts=>{detail=opts;}});
    await window.RacePages.rider_standings(ctx);
    assert.equal(selection.stage_scope,'final');
    assert.match(ctx.element.innerHTML,/Tied stages/);
    assert.match(ctx.element.innerHTML,/44<\/td>/);
    assert.equal(ctx.preferences.stageId,11);
    await click(ctx,'stage',12);
    await click(ctx,'fact',12);
    assert.deepEqual(Array.from(detail.path),[2,16]);
    assert.deepEqual(Array.from(detail.filters.stage_ids),[12]);
    assert.deepEqual(Array.from(detail.filters.rider_keys),[16]);
  });

  test('a linked rider outside the final five is shown with four comparators, with real-day rank swaps and separation', async () => {
    let chosen, destination;
    const field = Array.from({length:6},(_,i)=>({...rider,rider_key:i+1,rider_name:`Rider ${i+1}`,total_seconds:100000+i}));
    const tracks = field.flatMap((r,i)=>[
      mark(r,stages[0],i+1,i+1,0,80000+i),
      mark(r,stages[1],i===5?1:i+2,i+1,i===5?-52:i===0?200:80,94000+i)
    ]);
    const ctx = context({preferences:{riderKey:6},metadata:{stages,riders:field},
      analytics:async()=>field,report:async(name,f)=>tracks.filter(r=>f.rider_keys.includes(r.rider_key)),
      drill:o=>{chosen=o;},go:(name,opts)=>{destination=[name,opts];}});
    await window.RacePages.gc_evolution(ctx);
    assert.equal(ctx.preferences.riderKey,6);
    assert.equal(ctx.preferences.stageId,12);
    assert.match(ctx.element.innerHTML,/separation 252 s/);
    assert.match(ctx.element.innerHTML,/S12 \(4\)/);
    assert.deepEqual(Array.from(ctx.preferences.groupKeys),[6,1,2,3,4]);
    await click(ctx,'fact',6);
    assert.deepEqual(Array.from(chosen.filters.stage_ids),[12]);
    await click(ctx,'personal',6);
    assert.equal(destination[1].asOfStage,12);
    assert.equal(destination[1].riderKey,6);
  });

  test('time switches reveal boundary crossers and isolate actual bonus or penalty stages', async () => {
    const records = ['standard','no_bonus','no_penalty','raw'].flatMap(mode=>[
      {...rider,rider_key:1,rider_name:'Boundary rider',scenario:mode,baseline_rank:11,scenario_rank:mode==='raw'?9:11,
        rank_gain:mode==='raw'?2:0,baseline_gap:222,scenario_gap:150,baseline_seconds:80000,scenario_seconds:80002,
        winning_margin:mode==='raw'?246:264,bonus_seconds:2,penalty_seconds:0},
      {...rider,rider_key:2,rider_name:'Former top ten',scenario:mode,baseline_rank:10,scenario_rank:mode==='raw'?11:10,
        rank_gain:mode==='raw'?-1:0,winning_margin:mode==='raw'?246:264,bonus_seconds:0,penalty_seconds:5}
    ]);
    const ctx = context({report:async()=>records,analytics:async()=>[
      {...mark(rider,stages[0],11,11,0,120000),time_bonus_seconds:2},
      {...mark(rider,stages[1],11,11,0,134000),time_bonus_seconds:0}
    ]});
    await window.RacePages.time_rules(ctx);
    assert.doesNotMatch(ctx.element.innerHTML,/Boundary rider|Scenario GC|Places gained/);
    change(ctx,'gc-bonus-on','',false); change(ctx,'gc-penalty-on','',false);
    assert.match(ctx.element.innerHTML,/Scenario GC/);
    assert.match(ctx.element.innerHTML,/Entered/); assert.match(ctx.element.innerHTML,/Left/);
    assert.match(ctx.element.innerHTML,/246 s/);
    await click(ctx,'bonus',1);
    assert.match(ctx.element.innerHTML,/data-gc-action="fact" data-value="11"/);
    assert.doesNotMatch(ctx.element.innerHTML,/data-gc-action="fact" data-value="12"/);
    change(ctx,'gc-adjustment','penalty');
    assert.match(ctx.element.innerHTML,/No matching adjustments/);
  });


  test('narrowing dates keeps a withdrawn comparison rider and suppresses separation when that rider is missing',async()=>{
    const field = [1,2,3].map(k=>({...rider,rider_key:k,rider_name:`Rider ${k}`}));
    const tracks = field.flatMap(r=>r.rider_key===3 ? [mark(r,stages[0],3,3,2,80100)] : [
      mark(r,stages[0],r.rider_key,r.rider_key,0,80000),
      mark(r,stages[1],r.rider_key,r.rider_key,r.rider_key,94000)
    ]);
    const ctx = context({preferences:{riderKey:3},metadata:{stages,riders:field},filters:{team_keys:[2]},
      report:async(_name,f)=>tracks.filter(r=>f.stage_scope!=='selection' || f.stage_ids.includes(r.stage_id))});
    await window.RacePages.gc_evolution(ctx);
    assert.deepEqual(Array.from(ctx.preferences.groupKeys),[3,1,2]);
    ctx.filters = {team_keys:[2],stage_scope:'selection',stage_ids:[12]};
    await window.RacePages.gc_evolution(ctx);
    assert.deepEqual(Array.from(ctx.preferences.groupKeys),[3,1,2]);
    assert.match(ctx.element.innerHTML,/separation —/);
  });


  test('a temporal drill retains raw timing and the plotted subgroup for standings and daily history', async () => {
    const field = [9,121,122,123,124,125].map((k,i)=>({...rider,rider_key:k,rider_name:`Rider ${k}`,total_seconds:277647+i}));
    const tracks = field.map((r,i)=>mark(r,stages[1],i+1,i+1,i,277647+i));
    const f = {stage_scope:'selection',stage_ids:[12],team_keys:[2],rank_scope:'filtered',time_basis:'finish'};
    let target;
    const source = context({filters:f,preferences:{riderKey:9},metadata:{stages,riders:field},
      report:async(_name,selection)=>tracks.filter(r=>!selection.rider_keys || selection.rider_keys.includes(r.rider_key)),
      go:(_module,prefs)=>{target=prefs;}});
    await window.RacePages.gc_evolution(source);
    await click(source,'personal',9);
    const calls = [];
    const dest = context({filters:f,preferences:target,report:async(name,selection)=>{
      calls.push(selection);
      return name==='gc_trajectory' ? tracks : [{...field[0],gc_rank:1,gap_seconds:0}];
    }});
    await window.RacePages.rider_standings(dest);
    assert.match(dest.element.innerHTML,/raw time/);
    assert.match(dest.element.innerHTML,/Filtered group ranks/);
    for (const selection of calls) {
      assert.equal(selection.stage_scope,'as_of');
      assert.equal(selection.as_of_stage,12);
      assert.equal(selection.time_basis,'finish');
      assert.equal(selection.rank_scope,'filtered');
      assert.deepEqual(Array.from(selection.rider_keys),[9,121,122,123,124]);
      assert.deepEqual(Array.from(selection.team_keys),[2]);
      assert.equal(selection.stage_ids,undefined);
    }
  });


  test('typing filters standings without replacing the focused search input', async () => {
    const input = {id:'gc-find',value:"O'Connor",dataset:{}};
    const root = {ownerDocument:{activeElement:null},contains:()=>true,innerHTML:''};
    const slots = { '[data-gc-rank-results]': {innerHTML:''}, '[data-gc-panels]': {innerHTML:''} };
    root.querySelector = selector => slots[selector] || null;
    const ctx = context({element:root,report:async name=>name==='gc_comparison' ?
      [{...rider,rider_name:"Ben O'Connor"},{...rider,rider_key:5,rider_name:'Other rider'}] : []});
    await window.RacePages.rider_standings(ctx);
    root.ownerDocument.activeElement = input;
    Object.defineProperty(root,'innerHTML',{set(){throw Error('The focused input was removed');}});
    root.oninput({target:input});
    assert.match(slots['[data-gc-rank-results]'].innerHTML,/1 match/);
    assert.doesNotMatch(slots['[data-gc-rank-results]'].innerHTML,/Other rider/);
  });


test('switching focus reuses one filtered ranking cohort', async () => {
  const field = [1,2].map(k=>({...rider,rider_key:k,rider_name:'Rider '+k}));
  let reads=0;
  const ctx=context({filters:{rank_scope:'filtered'},metadata:{riders:field,stages},
    report:async name=>{
      if(name==='gc_comparison')return field;
      reads++;
      return field.map(r=>mark(r,stages[0],r.rider_key,r.rider_key,0,130000));
    }});
  await window.RacePages.rider_standings(ctx);
  await click(ctx,'rider',2);
  assert.equal(ctx.preferences.riderKey,2);
  assert.equal(reads,1);
});

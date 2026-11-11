const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const window={};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../web/static/team-pages.js'),'utf8'),{window,Intl,console});
const cell=(id,type,speed,extra={})=>({entity_kind:'rider',entity_key:id,entity_name:'Rider '+id,team_key:1,team_name:'Team',stage_type:type,speed_kmh:speed,sample_count:1,podium_count:0,mean_winner_gap_seconds:10,baseline_rank:id,mountain_rank:id,terrain_rank_gain:0,ranked_entities:12,...extra});
async function fixture(rows,preferences={}) {
 const element={innerHTML:'',querySelector:()=>null,contains:()=>true};
 const drills=[];
 const ctx={element,preferences,filters:{stage_scope:'as_of',as_of_stage:12},
  metadata:{stages:[{stage_id:1,stage_order:1,stage_type:'flat'},{stage_id:11,stage_order:11,stage_type:'mountain'},{stage_id:12,stage_order:12,stage_type:'mountain'}]},
  isCurrent:()=>true,report:async()=>rows,analytics:async()=>[],drill:value=>drills.push(JSON.parse(JSON.stringify(value)))};
 await window.RacePages.rider_specialisation(ctx);
 const click=(act,k='',extra={})=>element.onclick({target:{closest:()=>({dataset:{act,k:String(k),...extra}})}});
 const order=()=>[...element.innerHTML.matchAll(/<tr data-speed-key="(\d+)"/g)].map(m=>Number(m[1]));
 return {ctx,element,drills,click,order};
}

test('terrain leaders sort the selected type, include a cutoff tie and expand/collapse the field',async()=>{
 const rows=Array.from({length:12},(_,i)=>[cell(i+1,'mountain',50-(i===10?9:i)),cell(i+1,'flat',20+i)]).flat();
 const {ctx,element,click,order,drills}=await fixture(rows);
 assert.deepEqual(order(),[1,2,3,4,5,6,7,8,9,10,11]);
 assert.doesNotMatch(element.innerHTML,/First rider|Second rider/);
 click('show-leaders');assert.deepEqual(order(),[1,2,3,4,5,6,7,8,9,10,11,12]);
 click('show-leaders');assert.equal(order().length,11);
 click('terrain-type','flat');assert.deepEqual(order(),[12,11,10,9,8,7,6,5,4,3]);
 click('profile-days',12,{terrain:'flat'});
 assert.deepEqual(drills[0].filters.stage_ids,[1]);
 assert.deepEqual(drills[0].filters.rider_keys,[12]);
 assert.equal(ctx.filters.as_of_stage,12);
});

test('missing speeds and absent types are not ranked and do not widen the active scope',async()=>{
 const {element,order,click,ctx}=await fixture([cell(1,'mountain',null),cell(2,'mountain',38),cell(3,'flat',42)]);
 assert.deepEqual(order(),[2]);
 click('terrain-type','individual time-trial');
 assert.deepEqual(order(),[]);
 assert.match(element.innerHTML,/No riders completed Individual Time Trial/);
 assert.equal(ctx.preferences.terrainType,'individual time-trial');
 click('terrain-type','flat');assert.deepEqual(order(),[3]);
});

test('team speeds use ride counts and keep team drill filters separate from rider keys',async()=>{
 const rows=[cell(1,'mountain',37,{entity_kind:'team',entity_name:'Team One',sample_count:16}),cell(2,'mountain',39,{entity_kind:'team',entity_name:'Team Two',team_key:2,sample_count:15})];
 const {element,click,order,drills}=await fixture(rows,{entityKind:'team'});
 assert.deepEqual(order(),[2,1]);
 assert.match(element.innerHTML,/Completed rides/);
 click('profile-days',2,{terrain:'mountain'});
 assert.deepEqual(drills[0].filters.team_keys,[2]);
 assert.equal(drills[0].filters.rider_keys,undefined);
 assert.deepEqual(drills[0].filters.stage_ids,[11,12]);
});

test('mountain evidence is compact, expandable and retains podium and gap drill paths',async()=>{
 const rows=Array.from({length:12},(_,i)=>cell(i+1,'mountain',40-i,{podium_count:i%2,sample_count:2}));
 const {element,click,drills}=await fixture(rows);
 const mountainRows=()=>[...element.innerHTML.matchAll(/data-mountain-key="(\d+)"/g)];
 assert.equal(mountainRows().length,10);
 click('show-mountain');assert.equal(mountainRows().length,12);
 click('mountain-days',2,{metric:'podiums'});
 click('mountain-days',2,{metric:'gap'});
 assert.deepEqual(drills.map(d=>d.metric),['podiums','gap']);
 assert.deepEqual(drills[0].path,[1,2]);
 assert.deepEqual(drills[0].filters.stage_ids,[11,12]);
});

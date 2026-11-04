const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname,'../web/static/drilldown.js');
const d = fs.existsSync(file) ? require(file) : {};
assert.equal(typeof d.createModel,'function','Dedicated hierarchy model must exist');
const meta={
 teams:[{team_key:1,team_name:'Alpha',team_country_code:'FRA'},{team_key:2,team_name:'Beta',team_country_code:'GER'},{team_key:3,team_name:'<Gamma>',team_country_code:'BEL'}],
 riders:[{rider_key:1,bib_number:1,rider_name:'One',team_key:1,rider_country_code:'FRA',is_young_rider:true,finished_race_flag:1},{rider_key:2,bib_number:2,rider_name:'Two',team_key:1,rider_country_code:'UNK',is_young_rider:false,finished_race_flag:0},{rider_key:3,bib_number:3,rider_name:'Three',team_key:2,rider_country_code:'FRA',is_young_rider:false,finished_race_flag:1},{rider_key:4,bib_number:4,rider_name:'Four',team_key:3,rider_country_code:'GER',is_young_rider:true,finished_race_flag:1}],
 stages:[{stage_id:1,stage_order:1,stage_type:'flat',distance_km:100},{stage_id:2,stage_order:2,stage_type:'mountain',distance_km:200},{stage_id:3,stage_order:3,stage_type:'flat',distance_km:150}],
 countries:[{country_code:'FRA',country_name:'France'},{country_code:'GER',country_name:'Germany'},{country_code:'BEL',country_name:'Belgium'},{country_code:'ITA',country_name:'Italy'}]
};
const results=meta.riders.flatMap(r=>meta.stages.filter(s=>r.rider_key!==2||s.stage_id===1).map(s=>({...r,...s,finish_rank:r.rider_key,finish_time_seconds:100,adjusted_time_seconds:90,time_bonus_seconds:10,time_penalty_seconds:0})));
const standings=[{team_key:1,rank:1,total_seconds:999},{team_key:2,rank:2,total_seconds:1111}];
const model=(filters={})=>d.createModel({metadata:meta,filters,results,standings});
const view=(dim,role,path=[],m=model())=>d.getView(m,dim,role,path);
let v=view('team','registration');
assert.equal(v.rows.length,3);assert.equal(v.rows[0].total_seconds,999,'Use server team total, never sum the roster as team classification');
assert.equal(v.metrics.distance,450,'Distance counted once per stage, not per result');
assert.deepEqual(view('team','registration',['1']).rows.map(r=>r.key),['1','2'],'Exited unknown-nationality rider remains on roster');
assert.equal(view('team','registration',['1','2']).rows.length,1,'Exited rider retains only completed stages');
assert.equal(view('terrain','registration').rows.find(r=>r.key==='flat').stage_count,2);
assert.equal(view('terrain','registration',['flat']).rows.length,2);
assert.equal(view('terrain','registration',['flat','1']).rows.length,4);
assert.equal(view('terrain','registration',['flat','1']).rows[0].finish_rank,1);
assert.deepEqual(view('country','registration',['FRA']).rows.map(r=>r.key),['1']);
assert.deepEqual(view('country','nationality',['FRA']).rows.map(r=>r.key),['1','3']);
assert.deepEqual(view('country','registration',['FRA','1']).rows.map(r=>r.key),['1','2']);
assert.equal(view('country','nationality').metrics.riders,3,'Unknown excluded only in nationality hierarchy');
assert.equal(view('country','registration',['ITA']).rows.length,0,'Zero-participation countries remain reachable');
assert.equal(view('team','registration',[],model({team_keys:[]})).rows.length,0,'Explicit-empty cohort is not all');
assert.equal(view('terrain','registration',[],model({stage_scope:'selection',stage_ids:[]})).rows.length,0);
assert.equal(view('terrain','registration',[],model({stage_scope:'as_of',as_of_stage:1})).metrics.distance,100);
assert.equal(view('team','registration',['1'],model({young_only:true})).rows.length,1);
assert.equal(view('team','registration',['1','1'],model({time_basis:'finish'})).rows[0].selected_seconds,100);
assert.deepEqual(d.validPath(model({team_keys:[2]}),'team','registration',['1','2']),[]);
assert.deepEqual(d.validPath(model(),'team','registration',['1','9']),['1']);
assert.equal(d.escape('<script>&"'), '&lt;script&gt;&amp;&quot;');
console.log('Drill Down model: 22 assertions passed');

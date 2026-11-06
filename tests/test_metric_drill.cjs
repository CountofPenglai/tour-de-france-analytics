const test = require("node:test");
const assert = require("node:assert/strict");
const {createModel,metricView,mergeFilters} = require("../web/static/drilldown.js");

test("registered-team evidence changes grain from teams to roster to daily results",()=>{
  const metadata={teams:[{team_key:7,team_country_code:"FRA",team_name:"One squad"}],
    countries:[{country_code:"FRA",country_name:"France"}],stages:[{stage_id:1,stage_type:"flat"}],
    riders:[1,2].map(key=>({rider_key:key,team_key:7,rider_country_code:"BEL",rider_name:"Rider "+key}))};
  const model=createModel({metadata,results:[],standings:[]});
  const teams=metricView(model,"country","registration",["FRA"],"teams");
  assert.equal(teams.measureLabel,"Registered teams");assert.equal(teams.measureText,"1");
  const roster=metricView(model,"country","registration",["FRA","7"],"teams");
  assert.equal(roster.measureLabel,"Roster size");assert.equal(roster.measureText,"2");
  const days=metricView(model,"country","registration",["FRA","7","2"],"teams");
  assert.equal(days.measureLabel,"Completed rides");assert.equal(days.rows.length,0);
});

test("scoped drills intersect the eligible dates and preserve empty member selections",()=>{
  const stages=[{stage_id:1,stage_type:"flat"},{stage_id:2,stage_type:"mountain"}];
  const narrowed=mergeFilters({stage_scope:"as_of",as_of_stage:1,team_keys:[],young_only:true},
    {stage_types:["mountain"],team_keys:[7]},stages);
  assert.equal(narrowed.stage_scope,"selection");assert.deepEqual(narrowed.stage_ids,[]);
  assert.deepEqual(narrowed.team_keys,[]);assert.equal(narrowed.young_only,true);
});


test("placing metrics keep the completed rides denominator for each selected branch",()=>{
  const metadata={riders:[1,2].map(key=>({rider_key:key,team_key:key})),
    teams:[1,2].map(key=>({team_key:key,team_name:"Team "+key})),
    stages:[{stage_id:1,stage_type:"flat"},{stage_id:2,stage_type:"mountain"}]};
  const results=[{rider_key:1,team_key:1,stage_id:1,finish_rank:1},
    {rider_key:1,team_key:1,stage_id:2,finish_rank:12},{rider_key:2,team_key:2,stage_id:2,finish_rank:10}];
  const model=createModel({metadata,results});
  const root=metricView(model,"team","registration",[],"top10");
  assert.equal(root.measureText,"2");
  assert.equal(root.metrics.completed,3);
  const team=metricView(model,"team","registration",["1"],"wins");
  assert.equal(team.measureText,"1");
  assert.equal(team.metrics.completed,2);
});

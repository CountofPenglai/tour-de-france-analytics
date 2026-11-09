const test = require("node:test");
const assert = require("node:assert/strict");

global.window = {RacePages:{}};
require("../web/static/country-dashboard.js");

const slovenia = {
  country_code:"SLO", country_name:"Slovenia", rider_count:4, team_count:0,
  best_gc_rank:1, best_gc_riders:[{rider_key:1,rider_name:"Tadej Pogacar"}],
  stage_wins:4, podium_finishes:11,
  podium_rows:[{stage_id:4,rider_key:1,rider_name:"Tadej Pogacar",team_name:"UAE TEAM EMIRATES XRG",finish_rank:1,stage_type:"hilly"}],
};
const uae = {
  country_code:"UAE", country_name:"United Arab Emirates", rider_count:0, team_count:1,
  best_gc_rank:null, best_gc_riders:[], stage_wins:0, podium_finishes:0, podium_rows:[],
};
const pogacar = {
  rider_key:1, bib_number:1, rider_name:"Tadej Pogacar", team_key:10,
  team_name:"UAE TEAM EMIRATES XRG", rider_country_code:"SLO", rider_country_name:"Slovenia",
  team_country_code:"UAE", is_rider_national:true, is_team_registered:false, finished_race_flag:1,
};
const uaeRoster = [
  {...pogacar,is_rider_national:false,is_team_registered:true},
  ...Array.from({length:7},(_,index)=>({
    ...pogacar,rider_key:index+2,bib_number:index+2,rider_name:"Rider "+(index+2),
    rider_country_code:"POR",rider_country_name:"Portugal",is_rider_national:false,is_team_registered:true,
  })),
];

test("country story keeps nationality and registration separate through Slovenia to UAE", async () => {
  const root = {innerHTML:"",querySelector:()=>null};
  const requests = [];
  const ctx = {
    element:root, filters:{stage_scope:"final"}, preferences:{}, isCurrent:()=>true,
    report:async name => {assert.equal(name,"country_outcomes"); return [slovenia,uae];},
    analytics:async name => {assert.equal(name,"country_participation"); return [
      {country_code:"SLO",finisher_count:4,finisher_rate:1},
      {country_code:"UAE",finisher_count:0,finisher_rate:null},
    ];},
    post:async path => {
      requests.push(path);
      return path.includes("/SLO/") ? {rows:[pogacar],summary:{rider_national_count:4,registered_team_count:0,registered_team_member_count:0,union_member_count:4}} :
        {rows:uaeRoster,summary:{rider_national_count:0,registered_team_count:1,registered_team_member_count:8,union_member_count:8}};
    },
    go(){}, drill(){},
  };
  await window.RacePages.country_participation(ctx);
  assert.match(root.innerHTML,/Riders by nationality/);
  assert.match(root.innerHTML,/Teams by registration country/);
  const click = async (action,value) => root.onclick({target:{closest:()=>({dataset:{action,value}})}});
  await click("open-country","SLO");
  assert.match(root.innerHTML,/Tadej Pogacar/);
  assert.match(root.innerHTML,/registered in\s*<button[^>]+data-value="UAE"[^>]*>UAE →/);
  assert.match(root.innerHTML,/Open the 1 stage results behind these counts/);
  await click("open-country","UAE");
  assert.match(root.innerHTML,/Riders of this nationality<\/span><strong>0<\/strong>/);
  assert.match(root.innerHTML,/Teams registered here<\/span><strong>1<\/strong>/);
  assert.match(root.innerHTML,/Unique riders linked to this country<\/span><strong>8<\/strong>/);
  assert.match(root.innerHTML,/1 registered team<\/strong>/);
  assert.match(root.innerHTML,/No national riders in this selection/);
  assert.deepEqual(requests,["/api/country/SLO/members","/api/country/UAE/members"]);
  await click("back-countries","");
  assert.match(root.innerHTML,/Countries: participation and results/);
});

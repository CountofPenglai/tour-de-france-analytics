const test = require("node:test");
const assert = require("node:assert/strict");

global.window = {};
require("../web/static/route-pages.js");

function fixture(overrides) {
  const root = {innerHTML: "", querySelector: () => null, querySelectorAll: () => []};
  const ctx = {
    filters: {}, preferences: {}, element: {querySelector: () => root}, isCurrent: () => true,
    analytics: async () => [], report: async () => [], post: async () => ({rows: []}),
    go() {}, drill() {}, ...overrides,
  };
  return {ctx, root, click: async (action, value, extra = {}) =>
    root.onclick({target: {closest: () => ({dataset: {action, value: String(value), ...extra}})}})};
}

const stage = (id, type, km) => ({
  stage_id: id, stage_order: id, stage_type: type, distance_km: km, stage_date: "2025-07-05",
  start_location_name: "Start " + id, finish_location_name: "Finish " + id,
  winner_names: ["Winner <" + id + ">"],
});
const result = (rank, rider, team) => ({finish_rank: rank, rider_key: rider, rider_name: "Rider " + rider,
  bib_number: rider, team_key: team, team_name: "Team " + team, finish_time_seconds: 4000,
  adjusted_time_seconds: 3990, time_bonus_seconds: 10, time_penalty_seconds: 0});
const stages = [stage(1, "flat", 184.9), stage(2, "hilly", 209.1), stage(5, "individual time-trial", 33)];
const results = [result(1, 1, 8), result(10, 2, 8), result(10, 3, 9), result(12, 4, 8)];

test("stage shortcuts, source rank ties, full results, same-stage team evidence and rider trend", async () => {
  const requests = [], drills = [], trips = [];
  const {ctx, root, click} = fixture({filters: {young_only: true}, report: async () => stages,
    analytics: async (name, f) => {requests.push(f); return results;},
    drill: d => drills.push(d), go: (...args) => trips.push(args)});
  await window.RacePages.stage_summary(ctx);
  assert.match(root.innerHTML, /Winner &lt;1&gt;/);
  assert.match(root.innerHTML, /1:06:30/);
  assert.doesNotMatch(root.innerHTML, /Rider 4</);
  await click("stage-mode", "longest");
  assert.equal(ctx.preferences.stageId, 2);
  assert.deepEqual(requests.at(-1), {stage_scope:"selection", stage_ids:[2], young_only:true});
  await click("team", 8);
  assert.equal((root.innerHTML.match(/class="route-contributor"/g)||[]).length, 2);
  await click("full-stage", "");
  assert.match(root.innerHTML, /Rider 4</);
  await click("team-evidence", 8);
  assert.equal(drills.at(-1).metric, "top10");
  assert.deepEqual(drills.at(-1).path, [8]);
  assert.deepEqual(drills.at(-1).filters.stage_ids, [2]);
  await click("stage-rider", 2);
  assert.match(root.innerHTML, /Rider trend/);
  await click("trend", 2);
  assert.deepEqual(trips.at(-1), ["gc_evolution", {riderKey:2}]);
  await click("stage-mode", "itt");
  assert.equal(ctx.preferences.stageId, 5);
  assert.doesNotMatch(root.innerHTML, /Start 2/);
});

test("an explicit stage link escapes a previous ITT shortcut and an empty stage scope fetches no results", async () => {
  const first = fixture({preferences: {stageId:2,stageMode:"itt"}, report: async () => stages});
  await window.RacePages.stage_summary(first.ctx);
  assert.equal(first.ctx.preferences.stageId, 2);
  assert.match(first.root.innerHTML, /Start 2/);
  let calls = 0;
  const empty = fixture({filters: {stage_ids:[]}, preferences: {stageId:5}, analytics: async () => { calls++; return results; }});
  await window.RacePages.stage_summary(empty.ctx);
  assert.equal(calls, 0);
  assert.match(empty.root.innerHTML, /No stages/);
});

const members = [
  {rider_name:"Rider One", bib_number:1, rider_key:1, team_key:10, team_name:"First Team",
   rider_country_name:"France", is_rider_national:true, is_team_registered:true},
  {rider_name:"Rider Two", bib_number:2, rider_key:2, team_key:10, team_name:"First Team",
   rider_country_name:"Unknown / Unspecified", is_rider_national:false, is_team_registered:true},
];
const countries = [
  {country_code:"FRA", country_name:"France",rider_count:1,team_count:1,best_gc_rank:8,
   best_gc_riders:[{...members[0], gc_rank:8, total_seconds:350000},{...members[1], gc_rank:8, total_seconds:350000}],
   stage_wins:1,podium_finishes:2,podium_rows:[
     {...result(1,1,10),stage_id:2,stage_date:"2025-07-06",participation_status:"exited"},
     {...result(3,1,10),stage_id:5,stage_date:"2025-07-09",participation_status:"exited"}]},
  {country_code:"UAE",country_name:"United Arab Emirates",rider_count:0,team_count:1,
   best_gc_rank:null,best_gc_riders:[],stage_wins:0,podium_finishes:0,podium_rows:[]},
];
test("country metrics preserve both roles, tied GC and medal rows including exited riders", async () => {
  const drills = [], trips = [];
  const {ctx,root,click} = fixture({preferences:{countryCode:"FRA"},report:async () => countries,
    post:async () => ({rows:members}),drill: d => drills.push(d),go:(...args) => trips.push(args)});
  await window.RacePages.country_participation(ctx);
  assert.match(root.innerHTML, /Rider One/);
  assert.doesNotMatch(root.innerHTML, /Rider Two/);
  await click("country-cell","FRA",{metric:"team_count"});
  await click("registered-team",10);
  assert.match(root.innerHTML,/Unknown \/ Unspecified/);
  await click("country-drill","");
  assert.equal(drills.at(-1).role,"registration");
  assert.deepEqual(drills.at(-1).path,["FRA",10]);
  await click("country-view","results");
  await click("country-cell","FRA",{metric:"best_gc_rank"});
  assert.match(root.innerHTML,/Rider One/); assert.match(root.innerHTML,/Rider Two/);
  await click("final-rider",2);
  assert.deepEqual(trips.at(-1),["rider_standings",{riderKey:2,finalGC:true}]);
  await click("country-cell","FRA",{metric:"stage_wins"});
  assert.match(root.innerHTML,/2025-07-06/); assert.doesNotMatch(root.innerHTML,/2025-07-09/);
  await click("country-drill","");
  assert.equal(drills.at(-1).metric,"wins");
  await click("country-cell","FRA",{metric:"podium_finishes"});
  assert.match(root.innerHTML,/2025-07-09/);
  await click("country-cell","UAE",{metric:"best_gc_rank"});
  assert.match(root.innerHTML,/No qualifying/);
});

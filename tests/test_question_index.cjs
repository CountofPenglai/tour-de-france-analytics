const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const window = {};
const source = path.join(__dirname,'../web/static/question-index.js');
if (fs.existsSync(source)) vm.runInNewContext(fs.readFileSync(source,'utf8'),{window,structuredClone});

function fixture(overrides={}) {
  const root = {innerHTML:'',contains:()=>true};
  const trips=[],focused=[];
  assert.equal(typeof window.RaceQuestionIndex?.mount,'function');
  window.RaceQuestionIndex.mount(root,{
    go:async(module,preferences)=>trips.push({module,preferences}),
    isCurrent:()=>true, findTarget:selector=>selector, focus:target=>focused.push(target), ...overrides,
  });
  const click = id=>root.onclick({target:{closest:()=>({dataset:{question:id}})}});
  return {root,trips,focused,click};
}

test('all fifteen PDF prompts navigate to their corresponding analysis',async()=>{
  const {root,trips,focused,click}=fixture();
  assert.equal((root.innerHTML.match(/data-question="E\d+"/g)||[]).length,15);
  const destinations=['rider_standings','stage_summary','team_standings','rider_standings',
    'rider_specialisation','rider_specialisation','time_rules','country_participation',
    'country_participation','gc_evolution','stage_summary','team_standings','team_standings',
    'team_standings','stage_summary'];
  for(let i=0;i<destinations.length;i++) {
    await click('E'+(i+1));
    assert.equal(trips.at(-1).module,destinations[i]);
    assert.ok(focused.at(-1));
  }
  await click('E99');
  assert.equal(trips.length,15);
});

test('specialised questions select the required view without reusing mutated preferences',async()=>{
  const {trips,focused,click}=fixture();
  await click('E11');
  assert.deepEqual(trips.at(-1).preferences.stageTypes,['individual time-trial']);
  assert.equal(trips.at(-1).preferences.stageId,null);
  trips.at(-1).preferences.stageTypes.push('flat');
  await click('E11');
  assert.deepEqual(trips.at(-1).preferences.stageTypes,['individual time-trial']);
  await click('E15');
  assert.equal(trips.at(-1).preferences.stageMode,'longest');
  assert.deepEqual(trips.at(-1).preferences.stageTypes,[]);
  await click('E12');
  assert.equal(trips.at(-1).preferences.rosterMode,'all');
  assert.equal(trips.at(-1).preferences.showBurden,false);
  assert.equal(focused.at(-1),'#tt-roster');
  await click('E9');
  assert.equal(trips.at(-1).preferences.countryCode,null);
  assert.equal(focused.at(-1),'.country-table-block');
});

test('a superseded question does not steal focus after navigation',async()=>{
  const pending=[];
  const {focused,click}=fixture({go:()=>new Promise(resolve=>pending.push(resolve))});
  const old=click('E3'),fresh=click('E12');
  pending[1](); await fresh;
  pending[0](); await old;
  assert.deepEqual(focused,['#tt-roster']);
  const otherPage=fixture({isCurrent:()=>false});
  await otherPage.click('E1');
  assert.deepEqual(otherPage.focused,[]);
});

/* Regression probes execute real frontend handlers in a minimal DOM test harness. */
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../web/static/app.js'),'utf8').replace(/  if \(document\.readyState === "loading"\)[\s\S]*$/,`  globalThis.probe = {state,bindEvents,selectTeamForDrill,renderRiderSpecialisationTable,setPost:fn=>apiPost=fn,setEmbed:fn=>loadSignedEmbed=fn,setExplorer:fn=>refreshExplorerModule=fn};\n})();`);
class Element {
 constructor(id){Object.assign(this,{id,value:'',type:'',checked:false,textContent:'',innerHTML:'',events:{},dataset:{},open:false,classList:{add(){},remove(){},toggle(){}}});}
 addEventListener(name,fn){(this.events[name] ||= []).push(fn);}
 fire(name){for(const fn of this.events[name]||[])fn({preventDefault(){},target:this});}
 querySelectorAll(){return [];} querySelector(){return null;} getAttribute(){return null;} hasAttribute(){return false;} setAttribute(){} removeAttribute(){} scrollIntoView(){} focus(){}
 closest(selector){return selector==='details'?get('inspector-details'):selector==='#view-overview'?get('view-overview'):null;}
 showModal(){this.open=true;} close(value){this.open=false;this.returnValue=value;this.fire('close');}
}
const els=new Map();const get=id=>{if(!els.has(id))els.set(id,new Element(id));return els.get(id);};
const fullTable=new Element('full-table');fullTable.dataset.openModule='rider_standings';
const document={getElementById:get,querySelectorAll:s=>s==='[data-open-module]'?[fullTable]:[]};
const context={document,console,structuredClone,URLSearchParams,setTimeout,clearTimeout,RaceAppearance:require("../web/static/appearance.js")};vm.runInNewContext(source,context);
const p=context.probe;p.setEmbed(()=>Promise.resolve());p.setExplorer(()=>Promise.resolve());
const controls=['filter-stage-scope','filter-as-of-stage','filter-time-basis','filter-rank-scope','filter-team-aggregation','filter-team-select','filter-rider-select','filter-young-only'].map(get);
get('global-filter-form').querySelectorAll=()=>controls;
for(const [id,value] of Object.entries({'filter-stage-scope':'as_of','filter-as-of-stage':'21','filter-time-basis':'adjusted','filter-rank-scope':'overall','filter-team-aggregation':'stage_top3'}))get(id).value=value;
get('as-of-stage-caption').textContent='Through Stage 21';p.bindEvents();
get('open-filters-btn').fire('click');get('filter-as-of-stage').value='5';get('filter-as-of-stage').fire('change');get('close-filters-btn').fire('click');
assert.equal(get('filter-as-of-stage').value,'21');assert.equal(get('as-of-stage-caption').textContent,'Through Stage 21');
get('overview-classification-select').value='points_proxy';get('explore-classification-select').value='gc';fullTable.fire('click');assert.equal(get('explore-classification-select').value,'points_proxy');
// Chart/table navigation selects the canonical native tab without changing cohort.
let embedCalls=0;let explorerCalls=0;let explorerOptions;
p.setEmbed(()=>{embedCalls++;return Promise.resolve();});
p.setExplorer(opts=>{explorerOptions=opts;explorerCalls++;return Promise.resolve();});
p.state.activeExploreModule='country_participation';
const scopeBefore=controls.map(e=>[e.id,e.value,e.checked]);
get('explore-charts-btn').fire('click');
assert.equal(p.state.activeEmbedTabKey,'tab_4_countries');
assert.equal(p.state.activeEmbedTabIndex,4);
assert.equal(p.state.activeView,'overview');
assert.equal(embedCalls,1);
assert.deepEqual(controls.map(e=>[e.id,e.value,e.checked]),scopeBefore);
get('back-to-table-btn').fire('click');
assert.equal(p.state.activeView,'explore');
assert.equal(p.state.activeExploreModule,'country_participation');
assert.equal(explorerCalls,1);
assert.equal(explorerOptions.preservePage,true);
const terrainRows=Array.from({length:715},(_,i)=>({rider_key:i+1,rider_name:'Rider',stage_type:'flat'}));
p.state.specialisationPage=3;
p.renderRiderSpecialisationTable(get('explore-table-container'),terrainRows,{preservePage:true});
assert.equal(p.state.specialisationPage,3);
p.renderRiderSpecialisationTable(get('explore-table-container'),terrainRows.slice(0,95),{preservePage:true});
assert.equal(p.state.specialisationPage,1);
p.state.specialisationPage=3;
p.renderRiderSpecialisationTable(get('explore-table-container'),terrainRows);
assert.equal(p.state.specialisationPage,1);
get('inspector-details').open=false;p.setPost(async()=>{throw Error('Simulated failed roster request');});
(async()=>{await p.selectTeamForDrill(1,1,{focusTarget:'rider'});assert.equal(get('inspector-details').open,true);assert.match(get('drill-roster-container').innerHTML,/Unable to Load Team Roster/);console.log('UI regressions: 17 assertions passed');})().catch(e=>{console.error(e);process.exitCode=1;});

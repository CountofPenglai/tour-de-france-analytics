/* Real rendering/controller integration with a small DOM surface. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const insights=require('../web/static/insights.js');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/static/app.js'),'utf8').replace(/  if \(document\.readyState === "loading"\)[\s\S]*$/,`  globalThis.probe={state,refreshExplorerModule,configureInsightLayout,setPost:fn=>apiPost=fn,setSelect:fn=>selectTeamForDrill=fn};\n})();`);
class Element{
 constructor(id){Object.assign(this,{id,value:'',textContent:'',innerHTML:'',attrs:{},dataset:{},ownerDocument:{activeElement:null}});this.classes=new Set();this.classList={add:x=>this.classes.add(x),remove:x=>this.classes.delete(x),toggle:(x,on)=>on?this.classes.add(x):this.classes.delete(x)};}
 hasAttribute(k){return k in this.attrs;} setAttribute(k,v){this.attrs[k]=v;} getAttribute(k){return this.attrs[k]??null;}
 querySelectorAll(){return [];}querySelector(){return null;}closest(){return null;}contains(){return false;}addEventListener(){}focus(){}scrollIntoView(){}
}
const els=new Map(),get=id=>{if(!els.has(id))els.set(id,new Element(id));return els.get(id);};
const document={getElementById:get,querySelectorAll:()=>[]};
for(const [id,v] of Object.entries({'filter-stage-scope':'final','filter-time-basis':'adjusted','filter-rank-scope':'overall','filter-team-aggregation':'stage_top3'}))get(id).value=v;
const context={document,console,structuredClone,URLSearchParams,setTimeout,clearTimeout,RaceInsights:insights,RaceAppearance:require('../web/static/appearance.js')};vm.runInNewContext(source,context);
const p=context.probe;
const rows=[{rider_key:1,rider_name:'A',team_key:1,stage_type:'flat',win_count:2,top10_count:4,top10_ratio:4/7,sample_count:7}];
(async()=>{
 p.state.activeExploreModule='rider_specialisation';p.setPost(async url=>({rows:url.endsWith('rider_standings')?[{rider_key:1,rank:146}]:rows}));await p.refreshExplorerModule();
 assert.match(get('insight-story').innerHTML,/146/);
 let selectedOptions; p.setSelect((team,rider,opts)=>{selectedOptions=opts;});p.state.activeView='explore';
 get('insight-story').contains=()=>true;
 get('insight-story').onclick({type:'click',target:{closest:()=>({tagName:'BUTTON',dataset:{storyRider:'1',storyTeam:'1'}})}});
 assert.equal(selectedOptions.returnContext?.exploreModule,'rider_specialisation','Story drill must capture its own return destination');assert.ok(get('explore-table-container').classes.has('hidden'));
 p.configureInsightLayout('stage_summary');assert.ok(get('insight-story').classes.has('hidden'));assert.equal(get('insight-story').innerHTML,'');assert.ok(!get('explore-table-container').classes.has('hidden'));
 const pending=[];p.setPost(()=>new Promise(resolve=>pending.push(resolve)));p.state.activeExploreModule='rider_specialisation';
 const older=p.refreshExplorerModule(),fresh=p.refreshExplorerModule();pending[2]({rows:[]});pending[3]({rows:[]});await fresh;pending[0]({rows});pending[1]({rows:[{rider_key:1,rank:146}]});await older;
 assert.match(get('insight-story').innerHTML,/No results/);assert.ok(!get('insight-story').innerHTML.includes('146'),'Stale response must not restore old findings');
 p.setPost(async()=>{throw Error('Connection unavailable');});await p.refreshExplorerModule();assert.match(get('insight-story').innerHTML,/Insights unavailable/);assert.ok(!get('insight-story').innerHTML.includes('Loading insights'));
 const root=new Element('story');let events=[];const prefs={};insights.mount({element:root,module:'rider_specialisation',data:{rows:[...rows,{...rows[0],stage_type:'mountain',win_count:0}],standings:[]},filters:{},preferences:prefs,onRider:(...v)=>events.push(v)});root.contains=()=>true;
 root.onclick({type:'click',target:{closest:()=>({dataset:{storySelectRider:'1',storyTerrain:'mountain'},tagName:'BUTTON'})}});assert.equal(prefs.terrain,'mountain');assert.match(root.innerHTML,/0<\/strong> mountain wins/);
 root.onclick({type:'click',target:{closest:()=>({dataset:{storyRider:'1',storyTeam:'1'},tagName:'BUTTON'})}});assert.deepEqual(events,[[1,1]]);
 console.log('Insights UI: real render, legacy detail visibility, response ordering, errors, cell selection and rider actions passed');
})().catch(e=>{console.error(e);process.exitCode=1});

const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const app=fs.readFileSync(require('node:path').join(__dirname,'../web/static/app.js'),'utf8');
async function run(drill){
 const nodes=new Map();function element(id){if(!nodes.has(id))nodes.set(id,{id,value:'',classList:{toggle(){},add(){},remove(){}},getAttribute(){return null;},setAttribute(){},querySelectorAll(){return [];}});return nodes.get(id);}
 const context={document:{getElementById:element,querySelectorAll:()=>[]},URLSearchParams,console,structuredClone,setTimeout,clearTimeout,route:{applied:true,view:'drilldown',drill,teamKey:1,riderKey:2}};
 const source=app.replace(/  if \(document\.readyState === "loading"\)[\s\S]*$/,`bindEvents=()=>{};syncScopeControlVisibility=()=>{};updateScopeBanner=()=>{};loadHealth=async()=>{};loadMetadata=async()=>{};parseAndApplyUrlDeepLink=()=>route;loadSignedEmbed=async()=>{};refreshOverviewCards=async()=>{};selectTeamForDrill=async()=>{globalThis.inspected=true;};globalThis.run=initPortal;globalThis.state=state;})();`);
 vm.runInNewContext(source,context);await context.run();assert.equal(context.state.activeView,'overview','Legacy team/rider drill must show its inspector instead of an empty new workspace');assert.equal(context.inspected,true);
}
(async()=>{await run('team');await run('rider');console.log('Combined drill links: 2 cases passed');})().catch(e=>{console.error(e);process.exitCode=1});

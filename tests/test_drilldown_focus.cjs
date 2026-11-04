const assert=require('node:assert/strict');
const d=require('../web/static/drilldown.js');
const doc={activeElement:null};
const root={ownerDocument:doc,events:{},controls:new Map(),addEventListener(k,fn){this.events[k]=fn;},querySelector(k){return this.controls.get(k)||null;},set innerHTML(html){this.html=html;doc.activeElement=null;this.controls=new Map();for(const selector of ['#drill-country-role','#drill-level-heading','#drill-search','[data-dimension="country"]']){this.controls.set(selector,{id:selector,focus(){doc.activeElement=this;},scrollIntoView(){},setSelectionRange(){}});}}};
const meta={riders:[{rider_key:1,team_key:1,rider_country_code:'FRA'}],teams:[{team_key:1,team_name:'A',team_country_code:'FRA'}],stages:[{stage_id:1,stage_type:'flat'}],countries:[{country_code:'FRA',country_name:'France'}]};
const nav=d.mount({element:root,getMetadata:()=>meta,getFilters:()=>({}),apiPost:async()=>({rows:[]})});
const click=dataset=>root.events.click({target:{closest:()=>({dataset})}});
(async()=>{
 await nav.load();click({dimension:'country'});assert.equal(doc.activeElement?.id,'[data-dimension="country"]','Dimension keyboard focus retained after redraw');
 root.events.change({target:{id:'drill-country-role',value:'nationality'}});assert.equal(doc.activeElement?.id,'#drill-country-role','Country role selection retains focus');
 nav.choose('FRA');click({drillReset:''});assert.equal(doc.activeElement?.id,'#drill-level-heading','Reset focuses new results heading');
 console.log('Drill Down focus restoration: 3 cases passed');
})().catch(e=>{console.error(e);process.exitCode=1});

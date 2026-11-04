const assert=require('node:assert/strict'),fs=require('node:fs');
const i=require('../web/static/insights.js');
const css=fs.readFileSync(require('node:path').join(__dirname,'../web/static/insights.css'),'utf8');
const normal=css.match(/\.heat-cell \{[^}]*color:(#[a-f0-9]{6});/)[1];
const light=css.match(/\.heat-cell\.heat-dark \{ color:([^;]+);/)[1];
const rgb=c=>c==='white'?[255,255,255]:c==='black'?[0,0,0]:[1,3,5].map(n=>parseInt(c.slice(n,n+2),16));
const lum=c=>rgb(c).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,n)=>s+x*[.2126,.7152,.0722][n],0);
let minimum=Infinity;
for(let n=0;n<=100;n++){
 const html=i.renderTerrain({rows:[{rider_key:1,rider_name:'R',stage_type:'flat',top10_ratio:n/100,sample_count:100,top10_count:n}],standings:[]},{},{});
 const dark=/class="heat-cell heat-dark"/.test(html);
 const bg='#'+[240+(8-240)*n/100,247+(126-247)*n/100,247+(121-247)*n/100].map(x=>Math.round(x).toString(16).padStart(2,'0')).join('');
 const a=lum(dark?light:normal),b=lum(bg),contrast=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
 minimum=Math.min(minimum,contrast);assert.ok(contrast>=4.5,`Heat ${n}% has ${contrast.toFixed(2)}:1 text contrast`);
}
console.log(`Heatmap: all 101 rate values meet 4.5:1 contrast; minimum ${minimum.toFixed(2)}:1`);

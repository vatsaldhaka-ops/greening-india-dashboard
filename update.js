const fs=require('fs');const path=process.argv[2];const payload=JSON.parse(process.argv[3]);
let html=fs.readFileSync(path,'utf8');
const s=html.indexOf('const DATA = ');const objStart=html.indexOf('{',s);
let depth=0,i=objStart,instr=false,esc=false,q='';
for(;i<html.length;i++){const c=html[i];if(instr){if(esc)esc=false;else if(c==='\\')esc=true;else if(c===q)instr=false;}else{if(c==='"'||c==="'"){instr=true;q=c;}else if(c==='{')depth++;else if(c==='}'){depth--;if(depth===0)break;}}}
const closeIdx=i;const DATA=eval('('+html.slice(objStart,closeIdx+1)+')');
const today=payload.today;
const keys=DATA.sites.map(x=>x.key);
const prev=DATA.history.filter(h=>h.date!==today).slice(-1)[0];
const sites={};const carried=[];
for(const k of keys){const p=payload.plant[k];if(p&&typeof p.acres==='number'&&!isNaN(p.acres)){sites[k]={acres:p.acres,saplings:p.saplings,dAcres:p.dAcres,dSaplings:p.dSaplings};}else{const pv=((prev&&prev.sites)||{})[k]||{acres:0,saplings:0};sites[k]={acres:pv.acres,saplings:pv.saplings,dAcres:0,dSaplings:0};carried.push(k);}}
const entry={date:today,sites};const li=DATA.history.length-1;
if(DATA.history[li].date===today){DATA.history[li]=entry;}else{DATA.history.push(entry);}
const pay=payload.pay||{};const prevPay=(DATA.payments&&DATA.payments.sites)||{};const paySites={};const payCarried=[];
for(const k of keys){const q=pay[k];if(q&&typeof q.payAcres==='number'&&!isNaN(q.payAcres)){paySites[k]={acres:q.payAcres,dAcres:q.payDAcres};}else{const pv=prevPay[k]||{acres:0};paySites[k]={acres:pv.acres,dAcres:0};payCarried.push(k);}}
DATA.payments={date:today,sites:paySites};
DATA.updatedAt=today+'T20:00:00+05:30';
html=html.slice(0,s)+'const DATA = '+JSON.stringify(DATA)+html.slice(closeIdx+1);
fs.writeFileSync(path,html);const mirror=process.argv[4];if(mirror)fs.writeFileSync(mirror,html);
let tot=0,pt=0;keys.forEach(k=>{tot+=sites[k].acres;pt+=paySites[k].acres;});
console.log('sites='+keys.join(',')+'\nhistory='+DATA.history.length+' date='+today+' plantedAcres='+tot.toFixed(2)+' tokenPaidAcres='+pt.toFixed(2));
if(carried.length)console.log('WARNING plantation carried forward: '+carried.join(','));
if(payCarried.length)console.log('WARNING payments carried forward: '+payCarried.join(','));

// A6 check: 0.36 mm BCC struts at 6 mm cells in a 12 mm cylinder, Draft export.
const fs=require('fs'),path=require('path');
const { chromium } = require('playwright');
const { unzipSync, strFromU8 } = require('fflate');
const H=fs.readFileSync(__dirname+'/harness.js','utf8'); const NM=path.join(__dirname,'node_modules');
eval(H.slice(H.indexOf('const MIME'),H.indexOf('async function run')).replace(/\bconst (MIME|mime|ENTRY)\b/g,'var $1'));
const [ROOT,LABEL]=process.argv.slice(2);
const REC={family:'beam',beams:[[-1,-1,-1,1,1,1,1],[-1,-1,1,1,1,-1,1],[-1,1,-1,1,-1,1,1],[1,-1,-1,-1,1,1,1]],geometry:{mode:'solid',cell_scale:1,radius:0.12}};
(async()=>{
  const site='a.test';
  const browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
  const ctx=await browser.newContext({acceptDownloads:true});
  await ctx.addInitScript(()=>Object.defineProperty(Navigator.prototype,'hardwareConcurrency',{get:()=>8}));
  await ctx.route('**/*',async route=>{const url=route.request().url();const u=new URL(url);
    if(u.host===site){const p=u.pathname==='/'?'/index.html':decodeURIComponent(u.pathname);const f=path.join(ROOT,p);return fs.existsSync(f)?route.fulfill({body:fs.readFileSync(f),contentType:mime(f)}):route.fulfill({status:404,body:''});}
    if(u.host.startsWith('fonts.'))return route.fulfill({body:'',contentType:'text/css'});
    const hit=cdn(url);if(hit)return route.fulfill({body:hit.body,contentType:hit.type});return route.abort();});
  const page=await ctx.newPage(); const stages=[];
  page.on('console',m=>{const t=m.text(); if(/coarse|Empty/.test(t)) stages.push(t.split('\n')[0].slice(0,140));});
  await page.goto(`http://${site}/index.html?r=`+encodeURIComponent(JSON.stringify(REC)));
  await page.waitForTimeout(1500);
  await page.setInputFiles('#shapeInput',path.join(__dirname,'fixtures','body.stl'));
  await page.waitForSelector('.shapeCard[data-body-id]',{timeout:120000});
  await page.waitForFunction(()=>document.getElementById('computeOverlay').classList.contains('hidden'),null,{timeout:120000}).catch(()=>{});
  await page.click('.libraryChip'); await page.waitForTimeout(800);
  await page.evaluate(()=>{const i=document.getElementById('shapeCellSizeMm');i.value=6;window.onCellSizeInput();});
  await page.waitForTimeout(1500);
  await page.evaluate(()=>window.setQual('draft'));
  const sub=[]; const iv=setInterval(async()=>{try{const t=await page.evaluate(()=>document.getElementById('coSub').textContent); if(t&&!sub.includes(t))sub.push(t);}catch(e){}},700);
  const dl=page.waitForEvent('download',{timeout:500000}).then(async d=>{const z=unzipSync(fs.readFileSync(await d.path()));const x=strFromU8(z[Object.keys(z).find(k=>k.endsWith('.model'))]);return 'exported '+(x.match(/<triangle /g)||[]).length+' triangles';});
  const er=page.waitForSelector('.exp-err',{timeout:500000}).then(async h=>'error: '+(await h.textContent()).trim());
  page.evaluate(()=>window.triggerExport()).catch(()=>{});
  const r=await Promise.race([dl,er]); clearInterval(iv);
  console.log(`${LABEL}  thin BCC (0.36 mm struts) in 12 mm cylinder, Draft: ${r}`);
  const note=sub.find(s=>/coarse pass found no surface/.test(s)); if(note) console.log(`${LABEL}    progress: ${note}`);
  await browser.close();
})();

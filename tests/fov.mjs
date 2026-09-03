// Field of view. The shipped lens was 72 VERTICAL, which is 105 degrees
// HORIZONTAL on 16:9 and 119 on ultrawide — deep fisheye, and the first real
// playtester reported it as "the world feels distorted and misshapen, straight
// isn't straight, it's curved", and blamed the MOVEMENT (which is exact: a
// constant input walks a line with 0.0000 lateral deviation).
//
// 90 horizontal was the first correction and it was still too wide: the same
// tester read the residual barrel as skewed WALKING ("up on the stick moves me
// forward and slightly right"). Two defects wore one description — the stick
// had a real cross-axis leak (fixed in input.js) AND the lens was still open
// far enough to bend the straight line it walked. The default is now 78, and
// the pause-menu ladder moved with it (70 / 78 / 90) so the menu cannot claim
// a lens the camera is not running.
//
// So the invariant worth holding is aspect-independence: the horizontal angle
// must stay put as the window changes shape. A vertical-fov camera silently
// fails that, and no behavioural test notices.
import { createRequire } from "module";
import http from "http"; import fs from "fs"; import path from "path";
const require=createRequire(import.meta.url);
const {chromium}=require("/opt/node22/lib/node_modules/playwright");
import { fileURLToPath } from "url";
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const MIME={".html":"text/html",".js":"text/javascript",".css":"text/css"};
const serve=()=>http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split("?")[0]);if(p==="/")p="/index.html";
 const f=path.join(ROOT,p);if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);r.end();return;}
 r.writeHead(200,{"Content-Type":MIME[path.extname(f)]||"application/octet-stream"});fs.createReadStream(f).pipe(r);});
const fails=[];const A=(c,m)=>{if(!c)fails.push(m)};
(async()=>{
 const s=serve();await new Promise(r=>s.listen(0,"127.0.0.1",r));
 const url=`http://localhost:${s.address().port}/index.html`;
 const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args:["--use-gl=swiftshader","--enable-unsafe-swiftshader"]});
 const page=await b.newPage({viewport:{width:960,height:540}});
 const errs=[];page.on("pageerror",e=>errs.push(e.message));
 await page.goto(url,{waitUntil:"networkidle"});
 const def=await page.evaluate(()=>{ const M=window.__mirage; M.startRun({seed:1234}); M.advance(0.3);
   const c=M.renderer.camera; return {h:+(2*Math.atan(Math.tan(c.fov*Math.PI/360)*c.aspect)*180/Math.PI).toFixed(0), hfov:M.renderer.hfov,
     sel:document.querySelector('[data-fov].sel')?.dataset.fov}; });
 A(def.h===78,`default should be 78 horizontal, got ${def.h}`);
 // ...and the menu must not advertise a lens the camera is not running. On a
 // fresh profile the pre-selected button is whatever the static markup says,
 // so a default that drifts away from the ladder shows a silent lie.
 A(def.sel===String(def.h),`fresh profile: menu shows ${def.sel} but camera is at ${def.h}`);
 // change it in the pause menu
 const wide=await page.evaluate(()=>{ document.querySelector('[data-fov="90"]').click();
   const M=window.__mirage; M.advance(0.3); const c=M.renderer.camera;
   return {h:+(2*Math.atan(Math.tan(c.fov*Math.PI/360)*c.aspect)*180/Math.PI).toFixed(0),
           stored:JSON.parse(localStorage.getItem("mirage:settings")||"{}").fov}; });
 A(wide.h===90,`Wide should give 90 horizontal, got ${wide.h}`);
 A(wide.stored===90,`Wide should persist, stored ${wide.stored}`);
 // survive a reload AND apply to the new run's renderer
 await page.reload({waitUntil:"networkidle"});
 const after=await page.evaluate(()=>{ const M=window.__mirage; M.startRun({seed:1234}); M.advance(0.3);
   const c=M.renderer.camera;
   return {h:+(2*Math.atan(Math.tan(c.fov*Math.PI/360)*c.aspect)*180/Math.PI).toFixed(0),
           sel:document.querySelector('[data-fov].sel')?.dataset.fov}; });
 A(after.h===90,`the stored FOV should apply to a fresh run, got ${after.h}`);
 A(after.sel==="90",`the Wide button should be pre-selected, got ${after.sel}`);
 // aspect independence: a different window must keep the chosen angle, not warp
 await page.setViewportSize({width:1200,height:400}); // ultrawide-ish 3:1
 const ultra=await page.evaluate(()=>{ const M=window.__mirage; M.renderer.resize(); M.advance(0.3);
   const c=M.renderer.camera; return {a:+c.aspect.toFixed(2),
     h:+(2*Math.atan(Math.tan(c.fov*Math.PI/360)*c.aspect)*180/Math.PI).toFixed(0)}; });
 A(Math.abs(ultra.h-90)<=1,`horizontal FOV must hold across aspect ${ultra.a}, got ${ultra.h}`);
 // pause-menu grid: every row reachable, no two controls on the same row+col
 const grid=await page.evaluate(()=>{ const M=window.__mirage; M.act(M.ACTIONS.PAUSE);
   const els=[...document.querySelectorAll("#pauseLayer [data-row]")].filter(e=>e.offsetParent!==null);
   const seen={},dupes=[];
   els.forEach(e=>{const k=e.dataset.row+","+e.dataset.col; if(seen[k])dupes.push(k+" "+(e.id||e.textContent.trim())); seen[k]=1;});
   return {rows:[...new Set(els.map(e=>e.dataset.row))].sort(), dupes}; });
 A(grid.dupes.length===0,`pause menu has colliding grid cells: ${JSON.stringify(grid.dupes)}`);
 A(grid.rows.join()==="0,1,2,3",`pause rows should be 0-3, got ${grid.rows.join()}`);
 A(errs.length===0,`page errors: ${JSON.stringify(errs.slice(0,2))}`);
 await b.close(); s.close();
 if(fails.length){console.log(fails.length+" failed:");fails.forEach(f=>console.log("  ✗ "+f));process.exit(1);}
 console.log("field of view: OK — 78 default, adjustable, persists, aspect-independent, grid clean");
})().catch(e=>{console.error("CRASH:",e.message);process.exit(1);});

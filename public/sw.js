var API='tww-api-v1',NOTES='tww-notes';
var CACHED_API=['/api/posts','/api/opportunities','/api/scam-alerts'];
self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
var OFFLINE='<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Offline</title><body style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:24px;line-height:1.6"><h2>You are offline</h2><p>Open Tobi World Wide again when you have data. Meanwhile, here is what you saved.</p><h3>Saved notes</h3><div id=n>None saved yet. Use "Save offline" on a note when you have data.</div><h3>Latest news</h3><div id=p>Loading...</div><script>(function(){function e(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;"}[c]})}try{var m=JSON.parse(localStorage.getItem("tww_offline_notes")||"{}"),k=Object.keys(m);if(k.length)document.getElementById("n").innerHTML=k.map(function(i){return \'<p><a href="/offline-note/\'+i+\'">\'+e(m[i].title)+"</a> <small>"+e(m[i].subject)+"</small></p>"}).join("")}catch(x){}fetch("/api/posts").then(function(r){return r.json()}).then(function(l){document.getElementById("p").innerHTML=Array.isArray(l)&&l.length?l.slice(0,15).map(function(x){return "<p><b>"+e(x.h)+"</b><br>"+e(x.x)+"</p>"}).join(""):"No saved news yet."}).catch(function(){document.getElementById("p").textContent="No saved news yet."})})()<\/script>';
self.addEventListener('fetch',function(ev){
  var req=ev.request;if(req.method!=='GET')return;
  var url=new URL(req.url);if(url.origin!==location.origin)return;
  if(url.pathname.indexOf('/offline-note/')===0){
    ev.respondWith(caches.open(NOTES).then(function(c){return c.match(url.pathname)}).then(function(r){return r||new Response('This note was not saved on this device.',{status:404})}));
    return;
  }
  if(CACHED_API.indexOf(url.pathname)>=0){
    ev.respondWith(fetch(req).then(function(r){if(r.ok){var cp=r.clone();caches.open(API).then(function(c){c.put(req,cp)})}return r}).catch(function(){
      return caches.open(API).then(function(c){return c.match(req,{ignoreSearch:true})}).then(function(r){return r||new Response('[]',{headers:{'content-type':'application/json'}})})}));
    return;
  }
  if(req.mode==='navigate'){
    ev.respondWith(fetch(req).catch(function(){return new Response(OFFLINE,{headers:{'content-type':'text/html; charset=utf-8'}})}));
  }
});

self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',function(e){if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(function(){return new Response('<meta name=viewport content="width=device-width"><body style="font-family:sans-serif;padding:24px"><h2>You are offline</h2><p>Open Tobi World Wide again when you have data.</p>',{headers:{'content-type':'text/html'}})}))}});

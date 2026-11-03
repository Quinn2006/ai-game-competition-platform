(() => {
  let port,seq=0,earlyError=false;
  const send=(type,value)=>port?.postMessage({type,value,seq:++seq});
  window.addEventListener('message',event=>{
    if(event.source!==parent || event.data?.type!=='platform:init' || !event.ports[0] || port) return;
    port=event.ports[0];
    port.onmessage=event=>{
      const {type,value}=event.data??{};
      if(type==='save:loaded') window.dispatchEvent(new CustomEvent('platform:save',{detail:value}));
      if(type==='sound') document.querySelectorAll('audio,video').forEach(media=>{media.muted=false;media.play().catch(()=>send('sound:blocked'));});
    };
    window.PlatformGame=Object.freeze({save:value=>send('save',value),load:()=>send('load'),ready:()=>send('ready'),progress:value=>send('progress',value)});
    send('load');send('ready');
    if(earlyError)send('error');
    setInterval(()=>send('heartbeat'),1000);
    document.querySelectorAll('audio,video').forEach(media=>media.play().catch(()=>send('sound:blocked')));
  });
  for(const type of ['pointerdown','keydown','touchstart'])document.addEventListener(type,e=>{if(e.isTrusted)send('interaction');},true);
  window.addEventListener('error',()=>{earlyError=true;send('error');});
  window.addEventListener('unhandledrejection',()=>{earlyError=true;send('error');});
  document.addEventListener('click',event=>{
    const link=event.target.closest?.('a[href]');
    if(!link) return;
    const url=new URL(link.href,location.href);
    if(url.origin!==location.origin){event.preventDefault();send('external',url.href);}
  },true);
})();
